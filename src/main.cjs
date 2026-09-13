'use strict'

const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  shell,
  dialog,
  ipcMain,
  nativeTheme,
  nativeImage,
  session,
} = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { spawn } = require('node:child_process')
const http = require('node:http')
const https = require('node:https')
const {
  loadConfig,
  saveConfig,
  rememberServerUrl,
  normalizeUrl,
  configPath,
} = require('./config.cjs')

let config = null
let mainWindow = null
let tray = null
let startingCompose = false
let pendingDeepLink = null
const namedWindows = new Map()

function userData() {
  return app.getPath('userData')
}

function logsDir() {
  const dir = path.join(userData(), 'logs')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function iconPath() {
  const packaged = path.join(process.resourcesPath || '', 'icon.png')
  if (fs.existsSync(packaged)) return packaged
  return path.join(__dirname, '..', 'assets', 'icon.png')
}

function trayIconPath() {
  const candidates = [
    path.join(process.resourcesPath || '', 'tray-icon.png'),
    path.join(process.resourcesPath || '', 'icon.png'),
    path.join(__dirname, '..', 'assets', 'tray-icon.png'),
    path.join(__dirname, '..', 'assets', 'icon.png'),
  ]
  for (const p of candidates) {
    if (p && fs.existsSync(p)) return p
  }
  return iconPath()
}

function trayImage() {
  // Prefer a real on-disk tray asset — Linux StatusNotifier often mishandles resized NativeImage.
  const p = trayIconPath()
  const img = nativeImage.createFromPath(p)
  if (!img.isEmpty()) return img
  const fallback = nativeImage.createFromPath(iconPath())
  if (fallback.isEmpty()) return fallback
  return fallback.resize({ width: 32, height: 32 })
}

function page(name) {
  return path.join(__dirname, name)
}

function serverUrl() {
  return (config?.serverUrl || 'http://127.0.0.1:8080').replace(/\/$/, '')
}

function appOrigin() {
  try {
    return new URL(serverUrl()).origin
  } catch {
    return 'http://127.0.0.1:8080'
  }
}

function resolveAppUrl(url) {
  return new URL(url, `${serverUrl()}/`)
}

function isSameOriginAppUrl(url) {
  try {
    return resolveAppUrl(url).origin === appOrigin()
  } catch {
    return false
  }
}

function persistConfig(patch = {}) {
  config = saveConfig(userData(), { ...config, ...patch })
  applySessionPrefs()
  applyAutostart()
  return config
}

function fetchStatus(url, timeoutMs = 2500) {
  return new Promise((resolve) => {
    let settled = false
    const done = (ok) => {
      if (settled) return
      settled = true
      resolve(ok)
    }
    try {
      const lib = url.startsWith('https') ? https : http
      const req = lib.get(url, { timeout: timeoutMs }, (res) => {
        res.resume()
        done(res.statusCode >= 200 && res.statusCode < 500)
      })
      req.on('timeout', () => {
        req.destroy()
        done(false)
      })
      req.on('error', () => done(false))
    } catch {
      done(false)
    }
  })
}

async function waitUntilReady(baseUrl, { timeoutMs, intervalMs } = {}) {
  const t = timeoutMs ?? config.healthTimeoutMs
  const interval = intervalMs ?? config.healthIntervalMs
  const healthPath = config.healthPath.startsWith('/') ? config.healthPath : `/${config.healthPath}`
  const healthUrl = `${baseUrl}${healthPath}`
  const deadline = Date.now() + t
  while (Date.now() < deadline) {
    if (await fetchStatus(healthUrl)) return true
    if (await fetchStatus(baseUrl)) return true
    await new Promise((r) => setTimeout(r, interval))
  }
  return false
}

function runComposeUp(dir, profile) {
  return new Promise((resolve) => {
    if (!dir || !fs.existsSync(path.join(dir, 'docker-compose.yml'))) {
      resolve({ ok: false, error: 'No Compose project found' })
      return
    }
    const args = ['compose', '--project-directory', dir]
    if (profile) args.push('--profile', profile)
    args.push('up', '-d', '--remove-orphans')
    const child = spawn('docker', args, { cwd: dir, env: process.env })
    let stderr = ''
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.on('error', (err) => resolve({ ok: false, error: err.message }))
    child.on('close', (code) => {
      resolve(code === 0 ? { ok: true } : { ok: false, error: stderr.trim() || `exit ${code}` })
    })
  })
}

function sendStatus(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('canary:status', payload)
  }
}

function focusWindow(win) {
  if (!win || win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

function applyZoom(contents) {
  try {
    contents.setZoomFactor(config.zoomFactor || 1)
  } catch {
    // ignore
  }
}

function applySpellcheck(contents) {
  try {
    contents.session.setSpellCheckerEnabled(true)
    if (config.spellcheckLanguages?.length) {
      contents.session.setSpellCheckerLanguages(config.spellcheckLanguages)
    }
  } catch {
    // languages may be unavailable on some builds
  }
}

let downloadHandlerBound = false

function applySessionPrefs() {
  const ses = session.defaultSession
  if (config.downloadPath) {
    try {
      fs.mkdirSync(config.downloadPath, { recursive: true })
      ses.setDownloadPath(config.downloadPath)
    } catch (err) {
      console.warn('canary-desktop: download path:', err.message)
    }
  }
  if (!downloadHandlerBound) {
    downloadHandlerBound = true
    ses.on('will-download', (_event, item) => {
      if (config.downloadPath) {
        const dest = path.join(config.downloadPath, item.getFilename())
        item.setSavePath(dest)
      }
    })
  }
}

function autostartDesktopPath() {
  return path.join(os.homedir(), '.config', 'autostart', 'canary-desktop.desktop')
}

function applyAutostart() {
  const file = autostartDesktopPath()
  try {
    if (config.launchAtLogin) {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const body = `[Desktop Entry]
Type=Application
Name=Canary
Exec=/opt/Canary/canary --hidden
Icon=canary
X-GNOME-Autostart-enabled=true
StartupNotify=false
`
      fs.writeFileSync(file, body, 'utf8')
    } else if (fs.existsSync(file)) {
      fs.unlinkSync(file)
    }
  } catch (err) {
    console.warn('canary-desktop: autostart:', err.message)
  }
  try {
    app.setLoginItemSettings({ openAtLogin: Boolean(config.launchAtLogin), openAsHidden: true })
  } catch {
    // Linux often no-ops
  }
}

let boundsSaveTimer = null
function scheduleBoundsSave(fn) {
  clearTimeout(boundsSaveTimer)
  boundsSaveTimer = setTimeout(fn, 400)
}

function saveMainBounds() {
  if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.isVisible()) return
  if (mainWindow.isMinimized()) return
  const bounds = mainWindow.getBounds()
  scheduleBoundsSave(() => {
    config = saveConfig(userData(), {
      ...config,
      windowBounds: {
        ...config.windowBounds,
        main: bounds,
      },
    })
  })
}

function saveEditorBounds(name, win) {
  if (!name || !win || win.isDestroyed()) return
  const bounds = win.getBounds()
  scheduleBoundsSave(() => {
    config = saveConfig(userData(), {
      ...config,
      windowBounds: {
        ...config.windowBounds,
        editors: {
          ...(config.windowBounds.editors || {}),
          [name]: bounds,
        },
      },
    })
  })
}

function attachNavigationGuard(contents) {
  contents.on('will-navigate', (event, url) => {
    try {
      const target = new URL(url)
      if (target.origin !== appOrigin() && target.protocol !== 'file:') {
        event.preventDefault()
        void openExternalOrApp(url)
      }
    } catch {
      // ignore
    }
  })
}

async function openExternalOrApp(url) {
  if (config.externalLinks === 'app' && /^https?:\/\//i.test(url)) {
    const win = new BrowserWindow({
      width: 1200,
      height: 800,
      title: 'Canary',
      backgroundColor: '#0f172a',
      autoHideMenuBar: true,
      icon: iconPath(),
      webPreferences: {
        preload: path.join(__dirname, 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })
    attachWindowOpenHandler(win.webContents)
    applyZoom(win.webContents)
    applySpellcheck(win.webContents)
    await win.loadURL(url)
    focusWindow(win)
    return
  }
  await shell.openExternal(url)
}

function attachWindowOpenHandler(contents) {
  contents.setWindowOpenHandler(({ url, frameName }) => {
    if (isSameOriginAppUrl(url)) {
      const href = resolveAppUrl(url).href
      const name = frameName && frameName !== '_blank' ? frameName : ''

      if (name) {
        const existing = namedWindows.get(name)
        if (existing && !existing.isDestroyed()) {
          void existing.loadURL(href)
          focusWindow(existing)
          return { action: 'deny' }
        }
      }

      const remembered = name && config.windowBounds?.editors?.[name]
      return {
        action: 'allow',
        outlivesOpener: true,
        overrideBrowserWindowOptions: {
          width: remembered?.width || 1280,
          height: remembered?.height || 900,
          x: remembered?.x,
          y: remembered?.y,
          minWidth: 900,
          minHeight: 600,
          title: 'Canary',
          backgroundColor: '#0f172a',
          autoHideMenuBar: true,
          show: true,
          icon: iconPath(),
          webPreferences: {
            preload: path.join(__dirname, 'preload.cjs'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
          },
        },
      }
    }

    if (/^https?:\/\//i.test(url)) {
      void openExternalOrApp(url)
    }
    return { action: 'deny' }
  })

  contents.on('did-create-window', (childWindow, details) => {
    const name = details?.frameName && details.frameName !== '_blank' ? details.frameName : ''
    if (name) {
      namedWindows.set(name, childWindow)
      childWindow.on('closed', () => {
        saveEditorBounds(name, childWindow)
        if (namedWindows.get(name) === childWindow) namedWindows.delete(name)
      })
      childWindow.on('moved', () => saveEditorBounds(name, childWindow))
      childWindow.on('resized', () => saveEditorBounds(name, childWindow))
    }
    childWindow.setAutoHideMenuBar(true)
    childWindow.setMenuBarVisibility(false)
    applyZoom(childWindow.webContents)
    applySpellcheck(childWindow.webContents)
    focusWindow(childWindow)
    attachWindowOpenHandler(childWindow.webContents)
    attachNavigationGuard(childWindow.webContents)
  })

  contents.on('dom-ready', () => {
    applyZoom(contents)
    applySpellcheck(contents)
  })
}

async function bootIntoApp() {
  const base = serverUrl()
  sendStatus({ phase: 'checking', message: 'Looking for Canary…', url: base })

  const alreadyUp = await waitUntilReady(base, { timeoutMs: Math.min(4_000, config.healthTimeoutMs), intervalMs: 800 })
  if (alreadyUp) {
    await mainWindow.loadURL(base)
    await handlePendingDeepLink()
    return
  }

  const composeDir = config.composeDir || ''
  if (config.autoStart && composeDir && !startingCompose) {
    startingCompose = true
    sendStatus({
      phase: 'starting',
      message: `Starting local Canary stack from ${composeDir}…`,
      url: base,
    })
    const result = await runComposeUp(composeDir, config.composeProfile)
    startingCompose = false
    if (!result.ok) {
      sendStatus({
        phase: 'error',
        message: `Could not start Docker Compose: ${result.error}`,
        url: base,
        composeDir,
      })
      await mainWindow.loadFile(page('setup.html'))
      return
    }
    sendStatus({ phase: 'waiting', message: 'Waiting for Canary to become ready…', url: base })
    const ready = await waitUntilReady(base)
    if (ready) {
      await mainWindow.loadURL(base)
      await handlePendingDeepLink()
      return
    }
  }

  sendStatus({
    phase: 'offline',
    message: 'No Canary instance is reachable yet.',
    url: base,
    composeDir: composeDir || null,
  })
  await mainWindow.loadFile(page('setup.html'))
}

function createWindow({ show = true } = {}) {
  nativeTheme.themeSource = 'system'
  const saved = config.windowBounds?.main

  mainWindow = new BrowserWindow({
    width: saved?.width || 1440,
    height: saved?.height || 900,
    x: saved?.x,
    y: saved?.y,
    minWidth: 1024,
    minHeight: 700,
    title: 'Canary',
    backgroundColor: '#0f172a',
    show: false,
    autoHideMenuBar: true,
    icon: iconPath(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  mainWindow.once('ready-to-show', () => {
    if (show && !config.startMinimized) mainWindow.show()
    else if (config.startMinimized && tray) {
      // stay hidden; tray remains
    } else {
      mainWindow.show()
    }
  })

  mainWindow.on('moved', saveMainBounds)
  mainWindow.on('resized', saveMainBounds)
  mainWindow.on('close', saveMainBounds)
  mainWindow.on('close', (event) => {
    if (tray && config.trayEnabled && !app.isQuitting) {
      event.preventDefault()
      mainWindow.hide()
    }
  })

  attachWindowOpenHandler(mainWindow.webContents)
  attachNavigationGuard(mainWindow.webContents)

  void mainWindow.loadFile(page('loading.html')).then(() => bootIntoApp())
}

function openSettingsWindow() {
  const win = new BrowserWindow({
    width: 720,
    height: 780,
    title: 'Canary settings',
    backgroundColor: '#0b1220',
    autoHideMenuBar: true,
    icon: iconPath(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  void win.loadFile(page('settings.html'))
  focusWindow(win)
}

function buildTray() {
  if (!config.trayEnabled) {
    if (tray) {
      tray.destroy()
      tray = null
    }
    return
  }
  const trayPath = trayIconPath()
  if (!tray) {
    // Pass a filesystem path on Linux — StatusNotifier theme lookup is unreliable for NativeImage.
    tray = new Tray(trayPath)
    tray.setToolTip('Canary')
    const contextMenu = Menu.buildFromTemplate([
      {
        label: 'Show Canary',
        click: () => {
          if (!mainWindow) createWindow()
          else focusWindow(mainWindow)
        },
      },
      {
        label: 'Reconnect',
        click: () => {
          if (!mainWindow) createWindow()
          else {
            focusWindow(mainWindow)
            void mainWindow.loadFile(page('loading.html')).then(() => bootIntoApp())
          }
        },
      },
      { type: 'separator' },
      { label: 'Settings…', click: () => openSettingsWindow() },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          app.isQuitting = true
          app.quit()
        },
      },
    ])
    tray.setContextMenu(contextMenu)
    tray.on('click', () => {
      if (!mainWindow) createWindow()
      else if (mainWindow.isVisible()) mainWindow.hide()
      else focusWindow(mainWindow)
    })
  } else {
    tray.setImage(trayPath)
  }
}

function buildMenu() {
  const template = [
    {
      label: 'Canary',
      submenu: [
        {
          label: 'Reload',
          accelerator: 'CmdOrCtrl+R',
          click: () => {
            if (mainWindow) void mainWindow.loadURL(serverUrl())
          },
        },
        {
          label: 'Reconnect / start local stack',
          click: () => {
            if (!mainWindow) return
            void mainWindow.loadFile(page('loading.html')).then(() => bootIntoApp())
          },
        },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => openSettingsWindow() },
        {
          label: 'Open in browser',
          click: () => shell.openExternal(serverUrl()),
        },
        { type: 'separator' },
        {
          role: 'quit',
          label: 'Quit Canary',
          click: () => {
            app.isQuitting = true
            app.quit()
          },
        },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        {
          label: 'Actual size',
          accelerator: 'CmdOrCtrl+0',
          click: () => {
            persistConfig({ zoomFactor: 1 })
            for (const win of BrowserWindow.getAllWindows()) applyZoom(win.webContents)
          },
        },
        {
          label: 'Zoom in',
          accelerator: 'CmdOrCtrl+Plus',
          click: () => {
            persistConfig({ zoomFactor: Math.min(2, (config.zoomFactor || 1) + 0.1) })
            for (const win of BrowserWindow.getAllWindows()) applyZoom(win.webContents)
          },
        },
        {
          label: 'Zoom out',
          accelerator: 'CmdOrCtrl+-',
          click: () => {
            persistConfig({ zoomFactor: Math.max(0.5, (config.zoomFactor || 1) - 0.1) })
            for (const win of BrowserWindow.getAllWindows()) applyZoom(win.webContents)
          },
        },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Open logs folder',
          click: () => shell.openPath(logsDir()),
        },
        {
          label: 'Open config file',
          click: () => shell.openPath(configPath(userData())),
        },
        {
          label: 'Check for updates…',
          click: () => void checkForUpdates(true),
        },
        { type: 'separator' },
        {
          label: 'About Canary',
          click: () => {
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: 'About Canary',
              message: 'Canary CMS',
              detail: `Desktop shell ${app.getVersion()}\nChannel: ${config.updateChannel}\nTarget: ${serverUrl()}\nConfig: ${configPath(userData())}`,
            })
          },
        },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function parseDeepLink(argv) {
  const raw = (argv || []).find((a) => typeof a === 'string' && a.startsWith('canary:'))
  return raw || null
}

async function handleDeepLink(link) {
  if (!link) return
  let url
  try {
    url = new URL(link)
  } catch {
    return
  }
  if (url.protocol !== 'canary:') return

  const host = url.hostname || url.pathname.replace(/^\//, '').split('/')[0]
  const parts = url.pathname.replace(/^\//, '').split('/').filter(Boolean)

  if (!mainWindow || mainWindow.isDestroyed()) {
    pendingDeepLink = link
    return
  }
  focusWindow(mainWindow)

  // canary://open?url=https://…  or canary://connect?url=…
  if (host === 'open' || host === 'connect' || parts[0] === 'open') {
    const target = url.searchParams.get('url')
    if (target) {
      persistConfig(rememberServerUrl(config, target))
      await mainWindow.loadFile(page('loading.html'))
      await bootIntoApp()
    }
    return
  }

  // canary://editor/{caseId}/{fileId}
  if (host === 'editor' || parts[0] === 'editor') {
    const caseId = host === 'editor' ? parts[0] : parts[1]
    const fileId = host === 'editor' ? parts[1] : parts[2]
    if (caseId && fileId) {
      const href = `${serverUrl()}/editor/${caseId}/${fileId}`
      const name = `canary-oo-case-${caseId}-${fileId}`
      const existing = namedWindows.get(name)
      if (existing && !existing.isDestroyed()) {
        await existing.loadURL(href)
        focusWindow(existing)
        return
      }
      const win = new BrowserWindow({
        width: 1280,
        height: 900,
        title: 'Canary',
        backgroundColor: '#0f172a',
        autoHideMenuBar: true,
        icon: iconPath(),
        webPreferences: {
          preload: path.join(__dirname, 'preload.cjs'),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      })
      namedWindows.set(name, win)
      win.on('closed', () => {
        if (namedWindows.get(name) === win) namedWindows.delete(name)
      })
      attachWindowOpenHandler(win.webContents)
      attachNavigationGuard(win.webContents)
      applyZoom(win.webContents)
      await win.loadURL(href)
      focusWindow(win)
    }
  }
}

async function handlePendingDeepLink() {
  if (!pendingDeepLink) return
  const link = pendingDeepLink
  pendingDeepLink = null
  await handleDeepLink(link)
}

async function checkForUpdates(interactive) {
  const checkUrl = config.updateCheckUrl
  if (!checkUrl) {
    if (interactive) {
      await dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: 'Updates',
        message: 'No update check URL configured.',
      })
    }
    return
  }
  try {
    const body = await new Promise((resolve, reject) => {
      const lib = checkUrl.startsWith('https') ? https : http
      const req = lib.get(checkUrl, { timeout: 8000 }, (res) => {
        let data = ''
        res.on('data', (c) => {
          data += c
        })
        res.on('end', () => resolve({ status: res.statusCode, data }))
      })
      req.on('error', reject)
      req.on('timeout', () => {
        req.destroy()
        reject(new Error('timeout'))
      })
    })
    if (body.status >= 400) throw new Error(`HTTP ${body.status}`)
    const json = JSON.parse(body.data)
    const channel = config.updateChannel || 'stable'
    const remote =
      (json.channels && json.channels[channel]) || json.version || json.latest || null
    const download =
      (json.channels && json.channels[channel] && json.channels[channel].url) ||
      json.url ||
      json.downloadUrl ||
      'https://canarylegalsoftware.co.uk'
    const remoteVersion = typeof remote === 'object' ? remote.version : remote
    const remoteUrl = typeof remote === 'object' && remote.url ? remote.url : download
    if (!remoteVersion) throw new Error('No version in response')
    const current = app.getVersion()
    if (String(remoteVersion) === String(current)) {
      if (interactive) {
        await dialog.showMessageBox(mainWindow, {
          type: 'info',
          title: 'Updates',
          message: `Canary desktop ${current} is up to date.`,
          detail: `Channel: ${channel}`,
        })
      }
      return
    }
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Update available',
      message: `Version ${remoteVersion} is available (you have ${current}).`,
      detail: 'Open the download page?',
      buttons: ['Open download', 'Later'],
      defaultId: 0,
      cancelId: 1,
    })
    if (response === 0) await shell.openExternal(String(remoteUrl))
  } catch (err) {
    if (interactive) {
      await dialog.showMessageBox(mainWindow, {
        type: 'warning',
        title: 'Update check failed',
        message: 'Could not check for updates.',
        detail: `${err.message}\n\nYou can install a newer .deb from Canary when available.`,
      })
    }
  }
}

function bootstrapPayload() {
  return {
    ...config,
    url: serverUrl(),
    version: app.getVersion(),
    configPath: configPath(userData()),
    logsPath: logsDir(),
    userDataPath: userData(),
  }
}

ipcMain.handle('canary:get-bootstrap', () => bootstrapPayload())

ipcMain.handle('canary:get-config', () => bootstrapPayload())

ipcMain.handle('canary:save-config', async (_event, patch) => {
  const next = { ...config, ...(patch || {}) }
  if (patch?.serverUrl) Object.assign(next, rememberServerUrl(next, patch.serverUrl))
  persistConfig(next)
  buildTray()
  return bootstrapPayload()
})

ipcMain.handle('canary:retry', async (_event, opts = {}) => {
  if (opts?.serverUrl) {
    persistConfig(rememberServerUrl(config, opts.serverUrl))
  }
  if (!mainWindow) return { ok: false }
  await mainWindow.loadFile(page('loading.html'))
  await bootIntoApp()
  return { ok: true }
})

ipcMain.handle('canary:open-external', async (_event, url) => {
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
    await openExternalOrApp(url)
  }
})

ipcMain.handle('canary:open-path', async (_event, which) => {
  if (which === 'logs') return shell.openPath(logsDir())
  if (which === 'config') return shell.openPath(configPath(userData()))
  if (which === 'userData') return shell.openPath(userData())
  return ''
})

ipcMain.handle('canary:pick-directory', async () => {
  const result = await dialog.showOpenDialog(mainWindow || undefined, {
    properties: ['openDirectory', 'createDirectory'],
  })
  if (result.canceled || !result.filePaths[0]) return null
  return result.filePaths[0]
})

ipcMain.handle('canary:check-updates', async () => {
  await checkForUpdates(true)
  return { ok: true }
})

ipcMain.handle('canary:zoom-wheel', (event, deltaY) => {
  const dy = Number(deltaY) || 0
  if (!dy) return config.zoomFactor
  // Match typical browser notches: scroll down → zoom out
  const step = dy > 0 ? -0.1 : 0.1
  const next = Math.min(2, Math.max(0.5, Math.round(((config.zoomFactor || 1) + step) * 100) / 100))
  persistConfig({ zoomFactor: next })
  for (const win of BrowserWindow.getAllWindows()) applyZoom(win.webContents)
  return next
})

ipcMain.handle('canary:open-settings', async () => {
  openSettingsWindow()
  return { ok: true }
})

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    const link = parseDeepLink(argv)
    if (mainWindow) {
      focusWindow(mainWindow)
    }
    if (link) void handleDeepLink(link)
  })

  app.on('open-url', (event, url) => {
    event.preventDefault()
    void handleDeepLink(url)
  })

  app.whenReady().then(() => {
    config = loadConfig(userData())
    // Env overrides still win for one-shot launches
    if (process.env.CANARY_DESKTOP_URL) {
      config = persistConfig(rememberServerUrl(config, process.env.CANARY_DESKTOP_URL))
    }
    if (process.env.CANARY_COMPOSE_DIR) {
      config = persistConfig({ composeDir: process.env.CANARY_COMPOSE_DIR })
    }

    fs.mkdirSync(logsDir(), { recursive: true })
    applySessionPrefs()
    applyAutostart()
    app.setAsDefaultProtocolClient('canary')

    buildMenu()
    buildTray()

    const hidden = process.argv.includes('--hidden') || config.startMinimized
    createWindow({ show: !hidden })

    pendingDeepLink = parseDeepLink(process.argv)

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
      else if (mainWindow) focusWindow(mainWindow)
    })
  })

  app.on('before-quit', () => {
    app.isQuitting = true
    saveMainBounds()
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin' && !tray) app.quit()
  })
}

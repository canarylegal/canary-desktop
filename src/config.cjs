'use strict'

const fs = require('node:fs')
const path = require('node:path')

const DEFAULTS = {
  serverUrl: 'http://127.0.0.1:8080',
  recentUrls: ['http://127.0.0.1:8080'],
  composeDir: '',
  composeProfile: 'prod',
  autoStart: true,
  healthPath: '/api/health',
  healthTimeoutMs: 90_000,
  healthIntervalMs: 1500,
  externalLinks: 'system', // 'system' | 'app'
  downloadPath: '',
  spellcheckLanguages: ['en-GB'],
  zoomFactor: 1,
  startMinimized: false,
  launchAtLogin: false,
  trayEnabled: true,
  updateChannel: 'stable',
  updateCheckUrl: 'https://canarylegalsoftware.co.uk/desktop/version.json',
  windowBounds: {
    main: null,
    editors: {},
  },
}

function normalizeUrl(raw) {
  const s = String(raw || '').trim().replace(/\/$/, '')
  if (!s) return DEFAULTS.serverUrl
  try {
    const u = new URL(s.includes('://') ? s : `http://${s}`)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return DEFAULTS.serverUrl
    return u.origin + (u.pathname === '/' ? '' : u.pathname.replace(/\/$/, ''))
  } catch {
    return DEFAULTS.serverUrl
  }
}

function clampNumber(n, min, max, fallback) {
  const v = Number(n)
  if (!Number.isFinite(v)) return fallback
  return Math.min(max, Math.max(min, v))
}

function mergeConfig(raw) {
  const cfg = { ...DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) }
  cfg.serverUrl = normalizeUrl(cfg.serverUrl)
  cfg.recentUrls = Array.isArray(cfg.recentUrls)
    ? [...new Set(cfg.recentUrls.map(normalizeUrl).filter(Boolean))].slice(0, 12)
    : [...DEFAULTS.recentUrls]
  if (!cfg.recentUrls.includes(cfg.serverUrl)) {
    cfg.recentUrls = [cfg.serverUrl, ...cfg.recentUrls].slice(0, 12)
  }
  cfg.composeDir = typeof cfg.composeDir === 'string' ? cfg.composeDir.trim() : ''
  cfg.composeProfile = String(cfg.composeProfile || 'prod').trim() || 'prod'
  cfg.autoStart = cfg.autoStart !== false
  cfg.healthPath = String(cfg.healthPath || DEFAULTS.healthPath).trim() || DEFAULTS.healthPath
  if (!cfg.healthPath.startsWith('/')) cfg.healthPath = `/${cfg.healthPath}`
  cfg.healthTimeoutMs = clampNumber(cfg.healthTimeoutMs, 5_000, 600_000, DEFAULTS.healthTimeoutMs)
  cfg.healthIntervalMs = clampNumber(cfg.healthIntervalMs, 500, 30_000, DEFAULTS.healthIntervalMs)
  cfg.externalLinks = cfg.externalLinks === 'app' ? 'app' : 'system'
  cfg.downloadPath = typeof cfg.downloadPath === 'string' ? cfg.downloadPath.trim() : ''
  cfg.spellcheckLanguages = Array.isArray(cfg.spellcheckLanguages)
    ? cfg.spellcheckLanguages.map(String).filter(Boolean).slice(0, 8)
    : [...DEFAULTS.spellcheckLanguages]
  cfg.zoomFactor = clampNumber(cfg.zoomFactor, 0.5, 2, 1)
  cfg.startMinimized = Boolean(cfg.startMinimized)
  cfg.launchAtLogin = Boolean(cfg.launchAtLogin)
  cfg.trayEnabled = cfg.trayEnabled !== false
  cfg.updateChannel = String(cfg.updateChannel || 'stable').trim() || 'stable'
  cfg.updateCheckUrl = String(cfg.updateCheckUrl || DEFAULTS.updateCheckUrl).trim()
  cfg.windowBounds =
    cfg.windowBounds && typeof cfg.windowBounds === 'object'
      ? {
          main: cfg.windowBounds.main || null,
          editors:
            cfg.windowBounds.editors && typeof cfg.windowBounds.editors === 'object'
              ? cfg.windowBounds.editors
              : {},
        }
      : { main: null, editors: {} }
  return cfg
}

function configPath(userDataPath) {
  return path.join(userDataPath, 'config.json')
}

function loadConfig(userDataPath) {
  const file = configPath(userDataPath)
  try {
    if (fs.existsSync(file)) {
      return mergeConfig(JSON.parse(fs.readFileSync(file, 'utf8')))
    }
  } catch (err) {
    console.warn('canary-desktop: failed to read config:', err.message)
  }

  // Seed from env / common install paths on first run
  const seed = { ...DEFAULTS }
  if (process.env.CANARY_DESKTOP_URL) seed.serverUrl = process.env.CANARY_DESKTOP_URL
  if (process.env.CANARY_DESKTOP_HEALTH) seed.healthPath = process.env.CANARY_DESKTOP_HEALTH
  if (process.env.CANARY_COMPOSE_DIR) seed.composeDir = process.env.CANARY_COMPOSE_DIR
  else if (fs.existsSync('/opt/canarycms/docker-compose.yml')) seed.composeDir = '/opt/canarycms'
  if (process.env.CANARY_DESKTOP_AUTOSTART === '0') seed.autoStart = false
  const cfg = mergeConfig(seed)
  saveConfig(userDataPath, cfg)
  return cfg
}

function saveConfig(userDataPath, cfg) {
  const merged = mergeConfig(cfg)
  const file = configPath(userDataPath)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(merged, null, 2)}\n`, 'utf8')
  fs.renameSync(tmp, file)
  return merged
}

function rememberServerUrl(cfg, url) {
  const serverUrl = normalizeUrl(url)
  const recentUrls = [serverUrl, ...cfg.recentUrls.filter((u) => u !== serverUrl)].slice(0, 12)
  return { ...cfg, serverUrl, recentUrls }
}

module.exports = {
  DEFAULTS,
  normalizeUrl,
  loadConfig,
  saveConfig,
  rememberServerUrl,
  configPath,
  mergeConfig,
}

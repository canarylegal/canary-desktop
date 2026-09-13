'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('canaryDesktop', {
  getBootstrap: () => ipcRenderer.invoke('canary:get-bootstrap'),
  getConfig: () => ipcRenderer.invoke('canary:get-config'),
  saveConfig: (patch) => ipcRenderer.invoke('canary:save-config', patch),
  retry: (opts) => ipcRenderer.invoke('canary:retry', opts || {}),
  openExternal: (url) => ipcRenderer.invoke('canary:open-external', url),
  openPath: (which) => ipcRenderer.invoke('canary:open-path', which),
  pickDirectory: () => ipcRenderer.invoke('canary:pick-directory'),
  checkUpdates: () => ipcRenderer.invoke('canary:check-updates'),
  openSettings: () => ipcRenderer.invoke('canary:open-settings'),
  onStatus: (handler) => {
    const listener = (_event, payload) => handler(payload)
    ipcRenderer.on('canary:status', listener)
    return () => ipcRenderer.removeListener('canary:status', listener)
  },
})

// Ctrl + mouse wheel → zoom (browser-like). Capture so page scroll doesn't win.
window.addEventListener(
  'wheel',
  (event) => {
    if (!event.ctrlKey) return
    event.preventDefault()
    void ipcRenderer.invoke('canary:zoom-wheel', event.deltaY)
  },
  { passive: false, capture: true },
)

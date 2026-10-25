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
  submitYubiKey: (pin) => ipcRenderer.send('canary:yubikey-submit', pin),
  cancelYubiKey: () => ipcRenderer.send('canary:yubikey-cancel'),
  performWebAuthn: (payload) => ipcRenderer.invoke('canary:webauthn-ceremony', payload),
  onStatus: (handler) => {
    const listener = (_event, payload) => handler(payload)
    ipcRenderer.on('canary:status', listener)
    return () => ipcRenderer.removeListener('canary:status', listener)
  },
})

const webAuthnHook = `
(() => {
  if (window.__canaryWebAuthnHook) return
  window.__canaryWebAuthnHook = true
  const Proto = window.CredentialsContainer && CredentialsContainer.prototype
  if (!Proto) return
  function b64url(value) {
    const bytes = value instanceof ArrayBuffer
      ? new Uint8Array(value)
      : new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    let bin = ''
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
    return btoa(bin).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/g, '')
  }
  function fromB64url(text) {
    if (!text) return new ArrayBuffer(0)
    const pad = '='.repeat((4 - (text.length % 4)) % 4)
    const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/') + pad)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return bytes.buffer
  }
  function ceremony(payload) {
    const api = window.canaryDesktop
    if (!api || typeof api.performWebAuthn !== 'function') {
      return Promise.reject(new DOMException('Security key support is unavailable.', 'NotAllowedError'))
    }
    return api.performWebAuthn(payload).then((result) => {
      if (!result || !result.ok) {
        throw new DOMException(
          (result && result.message) || 'The operation was cancelled.',
          (result && result.name) || 'NotAllowedError',
        )
      }
      return result.credential
    })
  }
  function materialise(data, kind) {
    const response = { clientDataJSON: fromB64url(data.response.clientDataJSON) }
    if (kind === 'create') {
      response.attestationObject = fromB64url(data.response.attestationObject)
      response.getTransports = () => ['usb']
      if (data.response.authenticatorData) {
        response.getAuthenticatorData = () => fromB64url(data.response.authenticatorData)
      }
      if (typeof data.publicKeyAlgorithm === 'number') {
        response.getPublicKeyAlgorithm = () => data.publicKeyAlgorithm
      }
    } else {
      response.authenticatorData = fromB64url(data.response.authenticatorData)
      response.signature = fromB64url(data.response.signature)
      response.userHandle = data.response.userHandle ? fromB64url(data.response.userHandle) : null
    }
    return {
      id: data.id,
      rawId: fromB64url(data.rawId),
      type: 'public-key',
      authenticatorAttachment: 'cross-platform',
      getClientExtensionResults: () => ({}),
      response,
    }
  }
  function describe(kind, publicKey) {
    const selection = publicKey.authenticatorSelection || {}
    const params = publicKey.pubKeyCredParams || []
    const supported = [-7, -35, -8]
    const alg = supported.find((item) => params.some((param) => param.alg === item)) || -7
    const base = {
      kind,
      challenge: b64url(publicKey.challenge),
      userVerification: publicKey.userVerification || selection.userVerification || 'preferred',
      timeout: publicKey.timeout || 60000,
    }
    if (kind === 'get') {
      return {
        ...base,
        rpId: publicKey.rpId || location.hostname,
        allowCredentials: (publicKey.allowCredentials || []).map((item) => b64url(item.id)),
      }
    }
    return {
      ...base,
      rpId: (publicKey.rp && publicKey.rp.id) || location.hostname,
      rpName: (publicKey.rp && publicKey.rp.name) || '',
      resident: selection.residentKey === 'required' || selection.residentKey === 'preferred' || selection.requireResidentKey === true,
      userId: b64url(publicKey.user.id),
      userName: publicKey.user.name || '',
      userDisplayName: publicKey.user.displayName || '',
      excludeCredentials: (publicKey.excludeCredentials || []).map((item) => b64url(item.id)),
      alg,
    }
  }
  function wrap(name) {
    const orig = Proto[name]
    if (typeof orig !== 'function') return
    Proto[name] = function (options) {
      const publicKey = options && options.publicKey
      if (!publicKey || (options && options.mediation === 'conditional')) return orig.call(this, options)
      const kind = name === 'create' ? 'create' : 'get'
      return ceremony(describe(kind, publicKey)).then((data) => materialise(data, kind))
    }
  }
  wrap('get')
  wrap('create')
})()
`

function installWebAuthnHook() {
  try {
    const parent = document.documentElement || document.head
    if (!parent) return
    const script = document.createElement('script')
    script.textContent = webAuthnHook
    parent.appendChild(script)
    script.remove()
  } catch (err) {
    console.warn('canary-desktop: webauthn hook:', err.message)
  }
}

if (document.documentElement) installWebAuthnHook()
else window.addEventListener('DOMContentLoaded', installWebAuthnHook, { once: true })

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

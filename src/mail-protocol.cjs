'use strict'

function isCanaryMailProtocol(raw) {
  if (typeof raw !== 'string' || !raw) return false
  let url
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  const scheme = url.protocol.replace(/:$/, '').toLowerCase()
  return scheme === 'canary-eml' || scheme === 'ext+canary'
}

function emlFilename(name) {
  const parts = String(name || 'message.eml').split(/[/\\]/)
  let base = (parts[parts.length - 1] || 'message.eml').replace(/^\.+/, '').trim()
  if (!base) base = 'message.eml'
  if (!/\.eml$/i.test(base)) base = `${base}.eml`
  return base.slice(0, 180)
}

module.exports = {
  isCanaryMailProtocol,
  emlFilename,
}

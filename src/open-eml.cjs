'use strict'

const { emlFilename } = require('./mail-protocol.cjs')

function originBase(origin) {
  return String(origin || '').replace(/\/$/, '')
}

async function openPendingEmlInThunderbird({ origin, token, request, writeFile, launch }) {
  const base = originBase(origin)
  if (!base) throw new Error('Canary is not open on a server page yet.')

  const claimed = await request({
    url: `${base}/api/mail-plugin/pending-eml-open/claim`,
    method: 'POST',
    token,
  })
  const body = claimed && claimed.json && typeof claimed.json === 'object' ? claimed.json : {}
  const caseId = body.case_id
  const fileId = body.file_id
  const openToken = body.open_token
  if (!caseId || !fileId || !openToken) return { ok: false, reason: 'empty' }

  const download = await request({
    url: `${base}/api/cases/${encodeURIComponent(caseId)}/files/${encodeURIComponent(fileId)}/eml-open?token=${encodeURIComponent(openToken)}`,
    method: 'GET',
    token,
    binary: true,
  })
  const buffer = download && download.buffer
  if (!buffer || buffer.length === 0) throw new Error('The server returned an empty e-mail file.')

  const filePath = await writeFile(emlFilename(body.filename), buffer)
  await launch(filePath)

  try {
    await request({
      url: `${base}/api/mail-plugin/pending-eml-open`,
      method: 'DELETE',
      token,
    })
  } catch (err) {
    console.warn('canary-desktop: clear pending e-mail:', err.message)
  }
  return { ok: true, filePath }
}

module.exports = {
  openPendingEmlInThunderbird,
}

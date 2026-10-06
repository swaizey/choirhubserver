export async function getPdfObjectKey(pdfBytes) {
  const digest = await crypto.subtle.digest('SHA-256', pdfBytes)
  const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `pdfs/${hash}.pdf`
}

export async function storePdfIfAbsent(bucket, objectKey, pdfBytes) {
  if (await bucket.head(objectKey)) return true

  const result = await bucket.put(objectKey, pdfBytes, {
    onlyIf: { etagDoesNotMatch: '*' },
    httpMetadata: {
      contentType: 'application/pdf',
      cacheControl: 'public, max-age=31536000, immutable',
    },
  })
  return result === null
}

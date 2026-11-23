import { Readable } from 'node:stream'
import { BuckieError, BuckieErrorCode, payloadTooLarge } from '../errors/index.js'

export interface UploadGuardOptions {
  /** Maximum accepted size in bytes; 0 or undefined disables the limit. */
  maxBytes?: number
  /** Declared Content-Length; the upload fails if the body has a different size. */
  contentLength?: number | null
}

/**
 * Wrap an upload body so that it fails with 413 when it exceeds `maxBytes` and with 400
 * when it ends with a size different from the declared Content-Length. Because the failure
 * surfaces inside the storage provider's pipeline, its staging file is cleaned up.
 */
export function guardUpload(source: Readable, options: UploadGuardOptions): Readable {
  const { maxBytes = 0, contentLength = null } = options

  if (maxBytes > 0 && contentLength !== null && contentLength > maxBytes) {
    throw payloadTooLarge(maxBytes)
  }

  // Lazy on purpose: nothing is read from the source until the storage provider consumes the
  // stream, so a failure cannot fire before the provider is listening for it.
  async function* guarded(): AsyncGenerator<Buffer> {
    let seen = 0
    for await (const chunk of source) {
      const buf: Buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      seen += buf.length
      if (maxBytes > 0 && seen > maxBytes) throw payloadTooLarge(maxBytes)
      yield buf
    }
    if (contentLength !== null && contentLength !== seen) {
      throw new BuckieError(
        BuckieErrorCode.UPLOAD_INCOMPLETE,
        `Body size (${seen}) does not match Content-Length (${contentLength})`,
        400,
      )
    }
  }

  return Readable.from(guarded(), { objectMode: false })
}

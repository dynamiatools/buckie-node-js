import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import type { BucketService } from '../../storage/bucket.service.js'
import type { StorageService } from '../../storage/storage.service.js'
import type { ThumbnailService } from '../../thumbnail/thumbnail.service.js'
import type { IdentityService } from '../../auth/identity.service.js'
import type { OperationalLogger } from '../../logging/logger.js'
import { BuckieError, BuckieErrorCode, forbidden, successResponse } from '../../errors/index.js'
import { getMaxUploadBytes } from '../../config/config.service.js'
import { guardUpload } from '../../storage/upload-guard.js'
import { normalizeFit, normalizeFormat, parseSize } from '../../thumbnail/thumbnail.service.js'
import type { Permission, ListFilter } from '../../types/index.js'

function parseFilter(raw: unknown): ListFilter {
  if (raw === 'files' || raw === 'dirs') return raw
  return 'all'
}

interface ObjectRoutesOptions {
  bucketService: BucketService
  storageService: StorageService
  thumbnailService: ThumbnailService
  identityService: IdentityService
  logger: OperationalLogger
}

export async function objectRoutes(fastify: FastifyInstance, options: ObjectRoutesOptions): Promise<void> {
  const { bucketService, storageService, thumbnailService, identityService, logger } = options

  /**
   * Helper: resolve bucket and check permission
   */
  async function resolveBucketAndCheck(
    request: FastifyRequest,
    reply: FastifyReply,
    bucketName: string,
    key: string,
    permission: Permission,
  ) {
    const identity = request.authIdentity

    const grant = identityService.checkPermission(identity, bucketName, key, permission)
    if (!grant) {
      logger.logError('permission_denied', `Identity '${identity.identity}' lacks '${permission}' on '${bucketName}/${key}'`, {
        identity: identity.identity,
        bucket: bucketName,
        key,
        ip: request.ip,
      })
      throw forbidden(`Permission '${permission}' denied on bucket '${bucketName}' for path '${key}'`)
    }

    // Permission comes first, so identities without a grant cannot tell which buckets exist
    return bucketService.get(bucketName)
  }

  /** Headers for downloads; active content is forced to download and never sniffed. */
  function setDownloadHeaders(
    reply: FastifyReply,
    info: { mimeType: string; size: number; etag: string; lastModified: Date },
  ): void {
    reply.header('Content-Type', info.mimeType)
    reply.header('Content-Length', info.size.toString())
    reply.header('ETag', info.etag)
    reply.header('Last-Modified', info.lastModified.toUTCString())
    reply.header('Cache-Control', 'private, max-age=0')
    reply.header('X-Content-Type-Options', 'nosniff')
    reply.header('Content-Security-Policy', "default-src 'none'; sandbox")
    if (storageService.isActiveContent(info.mimeType)) {
      reply.header('Content-Disposition', 'attachment')
    }
  }

  /**
   * GET /:bucket - Bucket listing with pagination
   */
  fastify.get<{
    Params: { bucket: string }
    Querystring: { limit?: string; cursor?: string; filter?: string }
  }>('/:bucket', async (request, reply) => {
    const { bucket: bucketName } = request.params
    const parsedLimit = parseInt(typeof request.query.limit === 'string' ? request.query.limit : '100', 10)
    const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, 1000) : 100
    const cursor = typeof request.query.cursor === 'string' ? request.query.cursor : undefined
    const filter = parseFilter(request.query.filter)

    const bucket = await resolveBucketAndCheck(request, reply, bucketName, '/', 'read')
    const start = Date.now()

    const result = await storageService.listBucket(bucket, limit, cursor, filter)

    logger.log({
      event: 'list',
      identity: request.authIdentity.identity,
      bucket: bucketName,
      filter,
      elapsedMs: Date.now() - start,
      ip: request.ip,
    })

    return reply.send(successResponse(result))
  })

  /**
   * GET /:bucket/*key - Download file or list directory
   */
  fastify.get<{
    Params: { bucket: string; '*': string }
    Querystring: { w?: string; h?: string; fit?: string; format?: string; filter?: string }
  }>('/:bucket/*', async (request, reply) => {
    const { bucket: bucketName } = request.params
    const key = request.params['*'] ?? ''

    const bucket = await resolveBucketAndCheck(request, reply, bucketName, key, 'read')
    const start = Date.now()

    // If key ends with '/', it's a directory listing
    if (key.endsWith('/') || key === '') {
      const filter = parseFilter(request.query.filter)
      const result = await storageService.listDirectory(bucket, key, filter)
      logger.log({
        event: 'list',
        identity: request.authIdentity.identity,
        bucket: bucketName,
        key,
        filter,
        elapsedMs: Date.now() - start,
        ip: request.ip,
      })
      return reply.send(successResponse(result))
    }

    // Thumbnail request. Compatible with 1.0.0: non-numeric or negative sizes are ignored, unknown
    // fits fall back to 'cover' and oversized values are clamped. Only the output format is strict.
    const width = parseSize(request.query.w)
    const height = parseSize(request.query.h)
    if (width || height) {
      const rawFormat = request.query.format
      const thumb = await thumbnailService.getThumbnail(bucket, key, {
        width,
        height,
        fit: normalizeFit(typeof request.query.fit === 'string' ? request.query.fit : undefined),
        format: normalizeFormat(typeof rawFormat === 'string' ? rawFormat : 'webp'),
      })
      if (thumb) {
        reply.header('Content-Type', thumb.mimeType)
        reply.header('Content-Length', thumb.size.toString())
        reply.header('Cache-Control', 'private, max-age=86400')
        reply.header('X-Content-Type-Options', 'nosniff')
        logger.log({
          event: 'download',
          identity: request.authIdentity.identity,
          bucket: bucketName,
          key: `${key}?thumbnail`,
          size: thumb.size,
          elapsedMs: Date.now() - start,
          ip: request.ip,
        })
        return reply.send(thumb.stream)
      }
    }

    // Regular file download
    const download = await storageService.download(bucket, key)

    setDownloadHeaders(reply, download)

    logger.log({
      event: 'download',
      identity: request.authIdentity.identity,
      bucket: bucketName,
      key,
      size: download.size,
      elapsedMs: Date.now() - start,
      ip: request.ip,
    })

    return reply.send(download.stream)
  })

  /**
   * HEAD /:bucket/*key - Check file existence and retrieve metadata headers
   */
  fastify.head<{
    Params: { bucket: string; '*': string }
  }>('/:bucket/*', async (request, reply) => {
    const { bucket: bucketName } = request.params
    const key = request.params['*'] ?? ''

    if (!key) {
      return reply.status(400).send()
    }

    const bucket = await resolveBucketAndCheck(request, reply, bucketName, key, 'read')
    const start = Date.now()

    const info = await storageService.stat(bucket, key)

    setDownloadHeaders(reply, info)

    logger.log({
      event: 'head',
      identity: request.authIdentity.identity,
      bucket: bucketName,
      key,
      size: info.size,
      elapsedMs: Date.now() - start,
      ip: request.ip,
    })

    return reply.status(200).send()
  })

  /**
   * PUT /:bucket/*key - Upload file
   */
  fastify.put<{
    Params: { bucket: string; '*': string }
  }>('/:bucket/*', async (request, reply) => {
    const { bucket: bucketName } = request.params
    const key = request.params['*'] ?? ''

    if (!key) {
      return reply.status(400).send({
        ok: false,
        error: { code: BuckieErrorCode.PATH_INVALID, message: 'Key is required for upload' },
      })
    }

    const bucket = await resolveBucketAndCheck(request, reply, bucketName, key, 'write')
    const start = Date.now()

    logger.log({
      event: 'upload_started',
      identity: request.authIdentity.identity,
      bucket: bucketName,
      key,
      ip: request.ip,
    })

    try {
      const declared = request.headers['content-length']
      const body = guardUpload(request.raw, {
        maxBytes: getMaxUploadBytes(),
        contentLength: typeof declared === 'string' && /^\d+$/.test(declared) ? Number(declared) : null,
      })
      const result = await storageService.upload(bucket, key, body)

      logger.log({
        event: 'upload_committed',
        identity: request.authIdentity.identity,
        bucket: bucketName,
        key,
        size: result.size,
        elapsedMs: Date.now() - start,
        ip: request.ip,
      })

      return reply.status(201).send(successResponse({
        bucket: bucketName,
        key,
        size: result.size,
        etag: result.etag,
      }))
    } catch (err) {
      logger.logError('upload_failed', err instanceof Error ? err : String(err), {
        identity: request.authIdentity.identity,
        bucket: bucketName,
        key,
        elapsedMs: Date.now() - start,
        ip: request.ip,
      })
      throw err
    }
  })

  /**
   * DELETE /:bucket/*key - Delete file
   */
  fastify.delete<{
    Params: { bucket: string; '*': string }
  }>('/:bucket/*', async (request, reply) => {
    const { bucket: bucketName } = request.params
    const key = request.params['*'] ?? ''

    if (!key) {
      return reply.status(400).send({
        ok: false,
        error: { code: BuckieErrorCode.PATH_INVALID, message: 'Key is required for delete' },
      })
    }

    const bucket = await resolveBucketAndCheck(request, reply, bucketName, key, 'delete')
    const start = Date.now()

    await storageService.delete(bucket, key)

    logger.log({
      event: 'delete',
      identity: request.authIdentity.identity,
      bucket: bucketName,
      key,
      elapsedMs: Date.now() - start,
      ip: request.ip,
    })

    return reply.send(successResponse({ bucket: bucketName, key, deleted: true }))
  })
}


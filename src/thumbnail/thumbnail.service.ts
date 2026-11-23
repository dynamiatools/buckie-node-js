import path from 'node:path'
import crypto from 'node:crypto'
import fsp from 'node:fs/promises'
import fs from 'node:fs'
import sharp from 'sharp'
import type { Bucket } from '../types/index.js'
import { BucketService } from '../storage/bucket.service.js'
import { StorageService } from '../storage/storage.service.js'
import { getDataDir, resolveDataPaths } from '../config/config.service.js'
import { BuckieError, BuckieErrorCode, badRequest } from '../errors/index.js'

export const THUMBNAIL_FORMATS = ['webp', 'jpeg', 'png'] as const
export const THUMBNAIL_FITS = ['cover', 'contain', 'fill', 'inside', 'outside'] as const
export const MAX_DIMENSION = 4096
export const MAX_SOURCE_PIXELS = 64_000_000

export type ThumbnailFormat = typeof THUMBNAIL_FORMATS[number]
export type ThumbnailFit = typeof THUMBNAIL_FITS[number]

export interface ThumbnailOptions {
  width?: number
  height?: number
  fit?: ThumbnailFit
  format?: ThumbnailFormat
}

export interface ThumbnailResult {
  stream: fs.ReadStream
  mimeType: string
  size: number
}

/** Validate and normalize the output format ('jpg' is an alias of 'jpeg'). */
export function normalizeFormat(format: string): ThumbnailFormat {
  const f = format.toLowerCase() === 'jpg' ? 'jpeg' : format.toLowerCase()
  if (!(THUMBNAIL_FORMATS as readonly string[]).includes(f)) {
    throw badRequest(
      `Unsupported thumbnail format. Allowed: ${THUMBNAIL_FORMATS.join(', ')}`,
      BuckieErrorCode.THUMBNAIL_PARAM_INVALID,
    )
  }
  return f as ThumbnailFormat
}

/** Unknown fits fall back to 'cover', as in 1.0.0. */
export function normalizeFit(fit: string | undefined): ThumbnailFit {
  return (THUMBNAIL_FITS as readonly string[]).includes(fit ?? '') ? (fit as ThumbnailFit) : 'cover'
}

/**
 * Thumbnail size: undefined when absent, negative or non-numeric (as in 1.0.0);
 * clamped to MAX_DIMENSION otherwise.
 */
export function parseSize(raw: unknown): number | undefined {
  if (typeof raw !== 'string' || !/^\d{1,9}$/.test(raw)) return undefined
  const n = Math.min(Number(raw), MAX_DIMENSION)
  return n > 0 ? n : undefined
}

/**
 * Thumbnails are cached OUTSIDE the buckets, in the data directory's cache/thumbnails
 * folder, under a hashed file name. User input never reaches a file path.
 */
export class ThumbnailService {
  private readonly cacheDir: string

  constructor(
    private readonly bucketService: BucketService,
    private readonly storageService: StorageService,
    cacheDir?: string,
  ) {
    this.cacheDir = path.join(cacheDir ?? resolveDataPaths(getDataDir()).cacheDir, 'thumbnails')
  }

  async getThumbnail(bucket: Bucket, key: string, options: ThumbnailOptions): Promise<ThumbnailResult | null> {
    // Thumbnails are only supported for local-storage buckets
    if (bucket.storage && bucket.storage !== 'local') {
      return null
    }

    // Validate every parameter before touching the filesystem
    const format = normalizeFormat(options.format ?? 'webp')
    const fit = normalizeFit(options.fit)
    const width = validateDimension(options.width, 'w')
    const height = validateDimension(options.height, 'h')

    const filePath = this.bucketService.resolveKey(bucket, key)

    let originalStat: fs.Stats
    try {
      originalStat = await fsp.stat(filePath)
    } catch {
      return null
    }

    // Detect mime type — only process images
    const mimeType = await this.storageService.detectMimeType(filePath)
    if (!this.storageService.isImageMime(mimeType)) {
      return null
    }

    const hash = crypto
      .createHash('sha256')
      .update([bucket.name, filePath, width ?? 0, height ?? 0, fit, format].join('|'))
      .digest('hex')
    const cacheFile = path.join(this.cacheDir, `${hash}.${format}`)
    const outMime = `image/${format}`

    // Serve the cached thumbnail unless the original changed since
    try {
      const stat = await fsp.stat(cacheFile)
      if (stat.mtimeMs >= originalStat.mtimeMs) {
        return { stream: fs.createReadStream(cacheFile), mimeType: outMime, size: stat.size }
      }
    } catch {
      // Not cached yet — generate below
    }

    await fsp.mkdir(this.cacheDir, { recursive: true, mode: 0o700 })

    // Generate to a temp file, then rename, so readers never see a partial file
    const tmpFile = `${cacheFile}.tmp.${crypto.randomBytes(4).toString('hex')}`
    try {
      let pipeline = sharp(filePath, { limitInputPixels: MAX_SOURCE_PIXELS })

      if (width || height) {
        pipeline = pipeline.resize({ width, height, fit, withoutEnlargement: true })
      }

      if (format === 'webp') {
        pipeline = pipeline.webp({ quality: 85 })
      } else if (format === 'png') {
        pipeline = pipeline.png({ compressionLevel: 6 })
      } else {
        pipeline = pipeline.jpeg({ quality: 85 })
      }

      await pipeline.toFile(tmpFile)
      await fsp.rename(tmpFile, cacheFile)

      const stat = await fsp.stat(cacheFile)
      return { stream: fs.createReadStream(cacheFile), mimeType: outMime, size: stat.size }
    } catch {
      // Oversized, corrupt or unsupported source: clean up and fall back to the original
      await fsp.unlink(tmpFile).catch(() => {})
      return null
    }
  }
}

function validateDimension(value: number | undefined, name: string): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isInteger(value) || value < 0 || value > MAX_DIMENSION) {
    throw new BuckieError(
      BuckieErrorCode.THUMBNAIL_PARAM_INVALID,
      `Thumbnail '${name}' must be between 0 and ${MAX_DIMENSION}`,
      400,
    )
  }
  return value || undefined
}

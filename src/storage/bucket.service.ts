import path from 'node:path'
import fsp from 'node:fs/promises'
import fs from 'node:fs'
import { readConfig, writeConfig } from '../config/config.service.js'
import type { Bucket, StorageTarget, SftpConfig } from '../types/index.js'
import { BuckieError, BuckieErrorCode, notFound, conflict } from '../errors/index.js'

/** Internal directory name reserved inside each bucket root. */
const BUCKIE_INTERNAL_DIR = '.buckie'

export class BucketService {
  constructor(private readonly dataDir: string) {}

  /**
   * Create a new bucket.
   *
   * @param name        Unique bucket name.
   * @param bucketPath  Absolute path to the storage root.
   * @param storage     Storage backend (default: `'local'`).
   * @param sftp        Required when `storage` is `'sftp'`.
   */
  async create(
    name: string,
    bucketPath: string,
    storage: StorageTarget = 'local',
    sftp?: SftpConfig,
  ): Promise<Bucket> {
    if (!path.isAbsolute(bucketPath)) {
      throw new BuckieError(BuckieErrorCode.BUCKET_PATH_INVALID, `Bucket path must be absolute: ${bucketPath}`, 400)
    }

    const existing = await this.find(name)
    if (existing) {
      throw conflict(`Bucket '${name}' already exists`, BuckieErrorCode.BUCKET_ALREADY_EXISTS)
    }

    if (storage === 'sftp') {
      if (!sftp) {
        throw new BuckieError(BuckieErrorCode.BUCKET_PATH_INVALID, `sftp config is required when storage is 'sftp'`, 400)
      }

      const bucket: Bucket = {
        name,
        path: bucketPath,
        createdAt: new Date().toISOString(),
        storage: 'sftp',
        sftp,
      }

      const cfg = await readConfig(this.dataDir)
      cfg.buckets.push(bucket)
      await writeConfig(this.dataDir, cfg)
      return bucket
    }

    // ── local storage ──────────────────────────────────────────────────────

    // Ensure bucket dir exists
    await fsp.mkdir(bucketPath, { recursive: true })

    // Validate writable
    try {
      await fsp.access(bucketPath, fs.constants.W_OK)
    } catch {
      throw new BuckieError(BuckieErrorCode.BUCKET_PATH_NOT_WRITABLE, `Bucket path is not writable: ${bucketPath}`, 400)
    }

    // Create internal .buckie directory
    await this.ensureBucketInternals(bucketPath)

    const bucket: Bucket = {
      name,
      path: bucketPath,
      createdAt: new Date().toISOString(),
    }

    const cfg = await readConfig(this.dataDir)
    cfg.buckets.push(bucket)
    await writeConfig(this.dataDir, cfg)
    return bucket
  }

  async find(name: string): Promise<Bucket | null> {
    const cfg = await readConfig(this.dataDir)
    return cfg.buckets.find(b => b.name === name) ?? null
  }

  async get(name: string): Promise<Bucket> {
    const bucket = await this.find(name)
    if (!bucket) {
      throw notFound(`Bucket '${name}'`, BuckieErrorCode.BUCKET_NOT_FOUND)
    }
    return bucket
  }

  async list(): Promise<Bucket[]> {
    const cfg = await readConfig(this.dataDir)
    return cfg.buckets
  }

  async delete(name: string): Promise<void> {
    const cfg = await readConfig(this.dataDir)
    const before = cfg.buckets.length
    cfg.buckets = cfg.buckets.filter(b => b.name !== name)
    if (cfg.buckets.length === before) {
      throw notFound(`Bucket '${name}'`, BuckieErrorCode.BUCKET_NOT_FOUND)
    }
    await writeConfig(this.dataDir, cfg)
  }

  /**
   * Resolve a key to an absolute filesystem path within the bucket.
   * Only valid for `'local'` storage target buckets.
   * Validates against path traversal attacks.
   */
  resolveKey(bucket: Bucket, key: string): string {
    // Normalize to remove double slashes, . and ..
    const normalized = path.normalize(key).replace(/\\/g, '/')

    // Block access to internal .buckie directory
    const parts = normalized.split('/')
    if (parts.some(p => p === BUCKIE_INTERNAL_DIR)) {
      throw new BuckieError(BuckieErrorCode.PATH_RESERVED, `Access to internal '${BUCKIE_INTERNAL_DIR}' path is forbidden`, 403)
    }

    // Normalize bucket root to remove any trailing separator
    const bucketRoot = path.resolve(bucket.path)
    const resolved = path.resolve(bucketRoot, normalized.replace(/^\//, ''))

    // Ensure resolved path is within bucket root
    if (!resolved.startsWith(bucketRoot + path.sep) && resolved !== bucketRoot) {
      throw new BuckieError(BuckieErrorCode.PATH_TRAVERSAL, 'Path traversal detected', 400)
    }

    return resolved
  }

  validateKey(bucket: Bucket, key: string): string {
    return this.resolveKey(bucket, key)
  }

  async ensureBucketInternals(bucketPath: string): Promise<void> {
    const internalDir = path.join(bucketPath, BUCKIE_INTERNAL_DIR)
    await fsp.mkdir(path.join(internalDir, 'staging'), { recursive: true })
  }

  getStagingDir(bucket: Bucket): string {
    return path.join(bucket.path, BUCKIE_INTERNAL_DIR, 'staging')
  }

  /** @deprecated Thumbnails are now stored alongside originals in {WxH}/ subdirs. */
  getThumbsDir(bucket: Bucket): string {
    return path.join(bucket.path, BUCKIE_INTERNAL_DIR, 'thumbs')
  }
}

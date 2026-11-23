import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import fsp from 'node:fs/promises'
import { Readable } from 'node:stream'
import sharp from 'sharp'
import { BucketService } from '../src/storage/bucket.service.js'
import { StorageService } from '../src/storage/storage.service.js'
import { ThumbnailService, normalizeFormat, parseSize } from '../src/thumbnail/thumbnail.service.js'
import { IdentityService } from '../src/auth/identity.service.js'
import { ensureDataDirs, readConfig, updateConfig } from '../src/config/config.service.js'
import { guardUpload } from '../src/storage/upload-guard.js'
import type { Bucket } from '../src/types/index.js'

let tempDir: string
let dataDir: string
let bucketService: BucketService
let storageService: StorageService
let identityService: IdentityService

beforeEach(async () => {
  tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'buckie-hardening-'))
  dataDir = path.join(tempDir, 'data')
  await ensureDataDirs(dataDir)
  bucketService = new BucketService(dataDir)
  storageService = new StorageService(bucketService)
  identityService = new IdentityService(dataDir)
})

afterEach(async () => {
  // fs.rm does not follow symlinks
  await fsp.rm(tempDir, { recursive: true, force: true })
  delete process.env.BUCKIE_FOLLOW_SYMLINKS
})

describe('grant prefixes', () => {
  it('matches whole path segments', async () => {
    await identityService.create('t', 'secret')
    const id = await identityService.grant('t', { bucket: 'b', prefixes: ['/tenant-a'], permissions: ['read'] })
    expect(identityService.checkPermission(id, 'b', '/tenant-a/x.txt', 'read')).not.toBeNull()
    expect(identityService.checkPermission(id, 'b', '/tenant-a', 'read')).not.toBeNull()
    expect(identityService.checkPermission(id, 'b', '/tenant-ab/x.txt', 'read')).toBeNull()
  })

  it('treats a trailing slash as a boundary and "/" as everything', async () => {
    await identityService.create('t', 'secret')
    let id = await identityService.grant('t', { bucket: 'b', prefixes: ['/tenant-a/'], permissions: ['read'] })
    expect(identityService.checkPermission(id, 'b', '/tenant-a/x', 'read')).not.toBeNull()
    expect(identityService.checkPermission(id, 'b', '/tenant-ab/x', 'read')).toBeNull()
    id = await identityService.grant('t', { bucket: 'b', prefixes: ['/'], permissions: ['read'] })
    expect(identityService.checkPermission(id, 'b', '/anything', 'read')).not.toBeNull()
  })

  it('rejects prefixes with ".." or NUL', async () => {
    await identityService.create('t', 'secret')
    await expect(identityService.grant('t', { bucket: 'b', prefixes: ['/a/../b'], permissions: ['read'] })).rejects.toThrow('Invalid grant prefix')
    await expect(identityService.grant('t', { bucket: 'b', prefixes: ['/a\0'], permissions: ['read'] })).rejects.toThrow('Invalid grant prefix')
  })
})

describe('resolveKey', () => {
  let bucket: Bucket
  beforeEach(async () => {
    bucket = await bucketService.create('b', path.join(tempDir, 'b'))
  })

  it('blocks .buckie case-insensitively and NUL bytes', () => {
    expect(() => bucketService.resolveKey(bucket, '.BUCKIE/config')).toThrow('forbidden')
    expect(() => bucketService.resolveKey(bucket, 'a/.Buckie/x')).toThrow('forbidden')
    expect(() => bucketService.resolveKey(bucket, 'a\0b')).toThrow('Invalid key')
  })

  it('blocks symlinks that leave the bucket, unless opted in', async () => {
    const outside = path.join(tempDir, 'outside')
    await fsp.mkdir(outside)
    await fsp.writeFile(path.join(outside, 'secret.txt'), 'x')
    await fsp.symlink(outside, path.join(bucket.path, 'link'))
    await fsp.symlink(path.join(outside, 'secret.txt'), path.join(bucket.path, 'file-link'))

    expect(() => bucketService.resolveKey(bucket, 'link/secret.txt')).toThrow('Path traversal')
    expect(() => bucketService.resolveKey(bucket, 'link/new.txt')).toThrow('Path traversal')
    expect(() => bucketService.resolveKey(bucket, 'file-link')).toThrow('Path traversal')

    process.env.BUCKIE_FOLLOW_SYMLINKS = '1'
    expect(() => bucketService.resolveKey(bucket, 'link/secret.txt')).not.toThrow()
  })

  it('keeps working when the bucket path itself is a symlink', async () => {
    const real = path.join(tempDir, 'real')
    await fsp.mkdir(real)
    const linked = await bucketService.create('l', path.join(tempDir, 'linked-root'))
    await fsp.rm(linked.path, { recursive: true })
    await fsp.symlink(real, linked.path)
    expect(() => bucketService.resolveKey(linked, 'sub/file.txt')).not.toThrow()
  })
})

describe('uploads', () => {
  let bucket: Bucket
  beforeEach(async () => {
    bucket = await bucketService.create('u', path.join(tempDir, 'u'))
  })

  it('rejects a body larger than the limit and leaves no staging file', async () => {
    const body = guardUpload(Readable.from([Buffer.alloc(600), Buffer.alloc(600)]), { maxBytes: 1000 })
    await expect(storageService.upload(bucket, 'big.bin', body)).rejects.toMatchObject({ statusCode: 413 })
    await expect(fsp.stat(path.join(bucket.path, 'big.bin'))).rejects.toThrow()
    expect(await fsp.readdir(bucketService.getStagingDir(bucket))).toEqual([])
  })

  it('rejects a declared Content-Length above the limit up front', () => {
    expect(() => guardUpload(Readable.from([]), { maxBytes: 10, contentLength: 11 })).toThrow('maximum size')
  })

  it('rejects a body that does not match Content-Length', async () => {
    const body = guardUpload(Readable.from([Buffer.alloc(5)]), { contentLength: 10 })
    await expect(storageService.upload(bucket, 'short.bin', body)).rejects.toMatchObject({ code: 'BUCKIE_UPLOAD_INCOMPLETE' })
    await expect(fsp.stat(path.join(bucket.path, 'short.bin'))).rejects.toThrow()
  })

  it('refuses to upload over a directory and returns the same ETag as stat', async () => {
    await fsp.mkdir(path.join(bucket.path, 'dir'))
    await expect(storageService.upload(bucket, 'dir', Readable.from(['x']))).rejects.toThrow('is a directory')

    const result = await storageService.upload(bucket, 'f.txt', Readable.from(['hello']))
    expect(result.etag).toBe((await storageService.stat(bucket, 'f.txt')).etag)
  })

  it('classifies active content', () => {
    expect(storageService.isActiveContent('text/html; charset=utf-8')).toBe(true)
    expect(storageService.isActiveContent('image/svg+xml')).toBe(true)
    expect(storageService.isActiveContent('image/png')).toBe(false)
  })
})

describe('thumbnails', () => {
  it('validates format and parses sizes', () => {
    expect(normalizeFormat('JPG')).toBe('jpeg')
    expect(() => normalizeFormat('../../x')).toThrow('Unsupported thumbnail format')
    expect(() => normalizeFormat('gif')).toThrow('Unsupported thumbnail format')
    expect(parseSize('99999')).toBe(4096)
    expect(parseSize('-5')).toBeUndefined()
    expect(parseSize('abc')).toBeUndefined()
    expect(parseSize(undefined)).toBeUndefined()
  })

  it('caches outside the bucket under hashed names', async () => {
    const bucket = await bucketService.create('img', path.join(tempDir, 'img'))
    const png = await sharp({ create: { width: 40, height: 40, channels: 3, background: '#f00' } }).png().toBuffer()
    await fsp.writeFile(path.join(bucket.path, 'a.png'), png)

    const thumbs = new ThumbnailService(bucketService, storageService, path.join(dataDir, 'cache'))
    const result = await thumbs.getThumbnail(bucket, 'a.png', { width: 10, height: 10, format: 'png' })
    expect(result?.mimeType).toBe('image/png')
    result?.stream.destroy()

    expect(await fsp.readdir(bucket.path)).toEqual(['.buckie', 'a.png'])
    const cached = await fsp.readdir(path.join(dataDir, 'cache', 'thumbnails'))
    expect(cached).toHaveLength(1)
    expect(cached[0]).toMatch(/^[0-9a-f]{64}\.png$/)
  })

  it('rejects an invalid format and out-of-range sizes before touching the filesystem', async () => {
    const bucket = await bucketService.create('img2', path.join(tempDir, 'img2'))
    const thumbs = new ThumbnailService(bucketService, storageService, path.join(dataDir, 'cache'))
    await expect(thumbs.getThumbnail(bucket, 'a.png', { width: 10, format: 'gif' as never })).rejects.toThrow('Unsupported thumbnail format')
    await expect(thumbs.getThumbnail(bucket, 'a.png', { width: 5000 })).rejects.toThrow('must be between')
  })
})

describe('config', () => {
  it('throws on invalid JSON and never overwrites it, but treats an empty file as empty', async () => {
    const file = path.join(dataDir, 'config.json')
    await fsp.writeFile(file, '{ not json')
    await expect(readConfig(dataDir)).rejects.toThrow('not valid JSON')
    await expect(identityService.create('x', 's')).rejects.toThrow('not valid JSON')
    expect(await fsp.readFile(file, 'utf-8')).toBe('{ not json')

    await fsp.writeFile(file, '')
    expect(await readConfig(dataDir)).toEqual({ buckets: [], identities: [] })
  })

  it('creates a private file and preserves the mode of an existing one', async () => {
    await identityService.create('a', 's')
    const file = path.join(dataDir, 'config.json')
    expect((await fsp.stat(file)).mode & 0o777).toBe(0o600)

    await fsp.chmod(file, 0o640)
    await identityService.create('b', 's')
    expect((await fsp.stat(file)).mode & 0o777).toBe(0o640)
  })

  it('does not lose concurrent updates', async () => {
    await Promise.all(Array.from({ length: 20 }, (_, i) => identityService.create(`id-${i}`, 's')))
    expect((await readConfig(dataDir)).identities).toHaveLength(20)
  })

  it('serializes concurrent creates of the same identity', async () => {
    const results = await Promise.allSettled([identityService.create('dup', 's'), identityService.create('dup', 's')])
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
  })

  it('writes nothing when the mutation throws', async () => {
    await identityService.create('keep', 's')
    await expect(updateConfig(dataDir, () => { throw new Error('boom') })).rejects.toThrow('boom')
    expect((await readConfig(dataDir)).identities).toHaveLength(1)
  })
})

describe('login timing', () => {
  it('still verifies credentials and rejects unknown identities', async () => {
    await identityService.create('real', 'right')
    expect(await identityService.verify('real', 'right')).not.toBeNull()
    expect(await identityService.verify('real', 'wrong')).toBeNull()
    expect(await identityService.verify('ghost', 'right')).toBeNull()
  })
})

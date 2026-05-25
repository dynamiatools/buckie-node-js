import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import fsp from 'node:fs/promises'
import { BucketService } from '../src/storage/bucket.service.js'
import { StorageService } from '../src/storage/storage.service.js'
import { StorageProviderRegistry } from '../src/storage/storage.provider.js'
import type { StorageProvider } from '../src/storage/storage.provider.js'
import { ThumbnailService } from '../src/thumbnail/thumbnail.service.js'
import { IdentityService } from '../src/auth/identity.service.js'
import { ensureDataDirs } from '../src/config/config.service.js'
import { Readable } from 'node:stream'
import type { Bucket, ListResult } from '../src/types/index.js'
import type { DownloadResult } from '../src/storage/storage.provider.js'
import { BuckieError } from '../src/errors/index.js'

let tempDir: string
let bucketService: BucketService
let storageService: StorageService
let thumbnailService: ThumbnailService
let identityService: IdentityService

beforeEach(async () => {
  tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'buckie-test-'))
  await ensureDataDirs(tempDir)
  bucketService = new BucketService(tempDir)
  storageService = new StorageService(bucketService)
  thumbnailService = new ThumbnailService(bucketService, storageService)
  identityService = new IdentityService(tempDir)
})

afterEach(async () => {
  await fsp.rm(tempDir, { recursive: true, force: true })
})

// ──────────────────────────────────────────────────────────
// BucketService Tests
// ──────────────────────────────────────────────────────────
describe('BucketService', () => {
  it('should create a bucket', async () => {
    const bucketPath = path.join(tempDir, 'my-bucket')
    const bucket = await bucketService.create('test', bucketPath)
    expect(bucket.name).toBe('test')
    expect(bucket.path).toBe(bucketPath)
    expect(bucket.createdAt).toBeDefined()
  })

  it('should reject non-absolute paths', async () => {
    await expect(bucketService.create('bad', 'relative/path')).rejects.toThrow('must be absolute')
  })

  it('should prevent duplicate buckets', async () => {
    const bucketPath = path.join(tempDir, 'dup-bucket')
    await bucketService.create('dup', bucketPath)
    await expect(bucketService.create('dup', bucketPath)).rejects.toThrow('already exists')
  })

  it('should list buckets', async () => {
    await bucketService.create('b1', path.join(tempDir, 'b1'))
    await bucketService.create('b2', path.join(tempDir, 'b2'))
    const list = await bucketService.list()
    expect(list.length).toBe(2)
  })

  it('should delete a bucket', async () => {
    await bucketService.create('del', path.join(tempDir, 'del'))
    await bucketService.delete('del')
    const bucket = await bucketService.find('del')
    expect(bucket).toBeNull()
  })

  it('should detect path traversal attacks', async () => {
    const bucketPath = path.join(tempDir, 'safe-bucket')
    const bucket = await bucketService.create('safe', bucketPath)
    expect(() => bucketService.resolveKey(bucket, '../../../etc/passwd')).toThrow()
  })

  it('should block access to .buckie directory', async () => {
    const bucketPath = path.join(tempDir, 'internal-bucket')
    const bucket = await bucketService.create('internal', bucketPath)
    expect(() => bucketService.resolveKey(bucket, '.buckie/staging/file.txt')).toThrow()
  })
})

// ──────────────────────────────────────────────────────────
// IdentityService Tests
// ──────────────────────────────────────────────────────────
describe('IdentityService', () => {
  it('should create an identity', async () => {
    const identity = await identityService.create('test-user', 'secret123')
    expect(identity.identity).toBe('test-user')
    expect(identity.hashedSecret).not.toBe('secret123')
    expect(identity.grants).toEqual([])
  })

  it('should verify correct credentials', async () => {
    await identityService.create('verifiable', 'my-secret')
    const result = await identityService.verify('verifiable', 'my-secret')
    expect(result).not.toBeNull()
    expect(result?.identity).toBe('verifiable')
  })

  it('should reject incorrect credentials', async () => {
    await identityService.create('user1', 'correct-pass')
    const result = await identityService.verify('user1', 'wrong-pass')
    expect(result).toBeNull()
  })

  it('should return null for unknown identity', async () => {
    const result = await identityService.verify('unknown', 'any')
    expect(result).toBeNull()
  })

  it('should grant and check permissions', async () => {
    const id = await identityService.create('perm-user', 'pass')
    await identityService.grant('perm-user', {
      bucket: 'docs',
      prefixes: ['/tenant-a/'],
      permissions: ['read', 'write'],
    })

    const updated = await identityService.get('perm-user')
    const grant = identityService.checkPermission(updated, 'docs', '/tenant-a/file.pdf', 'read')
    expect(grant).not.toBeNull()

    const denied = identityService.checkPermission(updated, 'docs', '/tenant-b/file.pdf', 'read')
    expect(denied).toBeNull()
  })

  it('should revoke permissions', async () => {
    await identityService.create('rev-user', 'pass')
    await identityService.grant('rev-user', {
      bucket: 'docs',
      prefixes: [],
      permissions: ['read'],
    })
    await identityService.revoke('rev-user', 'docs')

    const id = await identityService.get('rev-user')
    expect(id.grants).toHaveLength(0)
  })

  it('should delete an identity', async () => {
    await identityService.create('deletable', 'pass')
    await identityService.delete('deletable')
    const found = await identityService.find('deletable')
    expect(found).toBeNull()
  })
})

// ──────────────────────────────────────────────────────────
// StorageService Tests
// ──────────────────────────────────────────────────────────
describe('StorageService', () => {
  let bucket: Awaited<ReturnType<typeof bucketService.create>>

  beforeEach(async () => {
    bucket = await bucketService.create('store', path.join(tempDir, 'store'))
  })

  it('should upload and download a file', async () => {
    const content = 'Hello, Buckie!'
    const source = Readable.from([content])
    await storageService.upload(bucket, 'test/hello.txt', source)

    const download = await storageService.download(bucket, 'test/hello.txt')
    const chunks: Buffer[] = []
    for await (const chunk of download.stream) {
      chunks.push(Buffer.from(chunk))
    }
    expect(Buffer.concat(chunks).toString('utf-8')).toBe(content)
    expect(download.size).toBe(content.length)
  })

  it('should delete a file', async () => {
    const source = Readable.from(['delete me'])
    await storageService.upload(bucket, 'to-delete.txt', source)
    await storageService.delete(bucket, 'to-delete.txt')
    await expect(storageService.download(bucket, 'to-delete.txt')).rejects.toThrow()
  })

  it('should throw on missing file download', async () => {
    await expect(storageService.download(bucket, 'nonexistent.txt')).rejects.toThrow()
  })

  it('should list directory contents', async () => {
    await storageService.upload(bucket, 'dir/a.txt', Readable.from(['a']))
    await storageService.upload(bucket, 'dir/b.txt', Readable.from(['b']))

    const result = await storageService.listDirectory(bucket, 'dir')
    expect(result.entries.length).toBe(2)
    const keys = result.entries.map(e => e.key)
    expect(keys).toContain('dir/a.txt')
    expect(keys).toContain('dir/b.txt')
  })

  it('should list a bucket with pagination', async () => {
    for (let i = 0; i < 5; i++) {
      await storageService.upload(bucket, `file-${i}.txt`, Readable.from([`content-${i}`]))
    }

    const page1 = await storageService.listBucket(bucket, 3)
    expect(page1.entries.length).toBe(3)
    expect(page1.hasMore).toBe(true)

    const page2 = await storageService.listBucket(bucket, 3, page1.cursor)
    expect(page2.entries.length).toBe(2)
    expect(page2.hasMore).toBe(false)
  })
})

// ──────────────────────────────────────────────────────────
// ThumbnailService Tests
// ──────────────────────────────────────────────────────────
describe('ThumbnailService.buildThumbKey', () => {
  it('should build key for a file in a subdirectory', () => {
    const key = thumbnailService.buildThumbKey('account1/producto.jpg', { width: 200, height: 200 })
    expect(key).toBe('account1/200x200/producto.jpg')
  })

  it('should build key for a file at bucket root', () => {
    const key = thumbnailService.buildThumbKey('photo.png', { width: 100, height: 100 })
    expect(key).toBe('100x100/photo.png')
  })

  it('should build key for a deeply nested file', () => {
    const key = thumbnailService.buildThumbKey('a/b/c/image.webp', { width: 300, height: 150 })
    expect(key).toBe('a/b/c/300x150/image.webp')
  })

  it('should use 0 for missing width or height', () => {
    const key = thumbnailService.buildThumbKey('img.jpg', { width: 400 })
    expect(key).toBe('400x0/img.jpg')
  })

  it('should return null for non-image files', async () => {
    const bucket = await bucketService.create('thumb-test', path.join(tempDir, 'thumb-test'))
    await storageService.upload(bucket, 'doc.txt', Readable.from(['hello']))
    const result = await thumbnailService.getThumbnail(bucket, 'doc.txt', { width: 200, height: 200 })
    expect(result).toBeNull()
  })

  it('should return null for missing files', async () => {
    const bucket = await bucketService.create('thumb-missing', path.join(tempDir, 'thumb-missing'))
    const result = await thumbnailService.getThumbnail(bucket, 'nonexistent.jpg', { width: 200, height: 200 })
    expect(result).toBeNull()
  })

  it('should return null for sftp buckets (thumbnails not supported)', async () => {
    const sftpBucket: Bucket = {
      name: 'sftp-thumb',
      path: '/remote/files',
      createdAt: new Date().toISOString(),
      storage: 'sftp',
      sftp: { host: 'localhost', port: 22, username: 'user', password: 'pass' },
    }
    const result = await thumbnailService.getThumbnail(sftpBucket, 'image.jpg', { width: 200, height: 200 })
    expect(result).toBeNull()
  })
})

// ──────────────────────────────────────────────────────────
// StorageProviderRegistry Tests
// ──────────────────────────────────────────────────────────
describe('StorageProviderRegistry', () => {
  it('should register and retrieve a provider', () => {
    const registry = new StorageProviderRegistry()
    const mockProvider = {} as StorageProvider
    registry.register('mock', mockProvider)
    expect(registry.get('mock')).toBe(mockProvider)
  })

  it('should throw for an unregistered target', () => {
    const registry = new StorageProviderRegistry()
    expect(() => registry.get('unknown')).toThrow(BuckieError)
    expect(() => registry.get('unknown')).toThrow('unknown')
  })

  it('should list all registered providers', () => {
    const registry = new StorageProviderRegistry()
    const p1 = {} as StorageProvider
    const p2 = {} as StorageProvider
    registry.register('a', p1)
    registry.register('b', p2)
    const all = registry.getAll()
    expect(all.size).toBe(2)
    expect(all.get('a')).toBe(p1)
    expect(all.get('b')).toBe(p2)
  })

  it('should allow overwriting a registered provider', () => {
    const registry = new StorageProviderRegistry()
    const p1 = {} as StorageProvider
    const p2 = {} as StorageProvider
    registry.register('local', p1)
    registry.register('local', p2)
    expect(registry.get('local')).toBe(p2)
  })
})

// ──────────────────────────────────────────────────────────
// StorageService provider routing tests
// ──────────────────────────────────────────────────────────
describe('StorageService provider routing', () => {
  it('should auto-register local provider', () => {
    const registry = new StorageProviderRegistry()
    const svc = new StorageService(bucketService, registry)
    // Retrieving the local provider should not throw
    expect(() => registry.get('local')).not.toThrow()
  })

  it('should allow registering a custom provider', async () => {
    const calls: string[] = []
    const customProvider: StorageProvider = {
      async initBucket() { calls.push('init') },
      async validateBucket() { calls.push('validate') },
      async download() { return {} as DownloadResult },
      async upload() { return { size: 0, etag: '' } },
      async delete() {},
      async listDirectory() { return {} as ListResult },
      async listBucket() { return {} as ListResult },
    }

    storageService.registerProvider('custom', customProvider)
    const bucket: Bucket = {
      name: 'custom-bucket',
      path: path.join(tempDir, 'custom-path'),
      createdAt: new Date().toISOString(),
      storage: 'custom' as any,
    }

    await storageService.initBucket(bucket)
    expect(calls).toContain('init')
  })

  it('should use local provider for buckets without storage field', async () => {
    const bucket = await bucketService.create('routing-test', path.join(tempDir, 'routing-test'))
    expect(bucket.storage).toBeUndefined()
    // Local provider should handle this bucket
    const content = 'routing test'
    await storageService.upload(bucket, 'file.txt', Readable.from([content]))
    const result = await storageService.download(bucket, 'file.txt')
    const chunks: Buffer[] = []
    for await (const chunk of result.stream) {
      chunks.push(Buffer.from(chunk))
    }
    expect(Buffer.concat(chunks).toString()).toBe(content)
  })
})

// ──────────────────────────────────────────────────────────
// BucketService SFTP creation tests
// ──────────────────────────────────────────────────────────
describe('BucketService SFTP buckets', () => {
  it('should create an sftp bucket with sftp config', async () => {
    const bucket = await bucketService.create('sftp-test', '/remote/files', 'sftp', {
      host: 'sftp.example.com',
      port: 22,
      username: 'deploy',
      password: 'secret',
    })
    expect(bucket.storage).toBe('sftp')
    expect(bucket.sftp?.host).toBe('sftp.example.com')
    expect(bucket.sftp?.username).toBe('deploy')
    expect(bucket.path).toBe('/remote/files')
  })

  it('should persist and reload sftp bucket metadata', async () => {
    await bucketService.create('sftp-persist', '/remote/persist', 'sftp', {
      host: 'sftp.example.com',
      port: 2222,
      username: 'user',
      privateKey: '-----BEGIN RSA PRIVATE KEY-----\n...',
    })
    const loaded = await bucketService.find('sftp-persist')
    expect(loaded).not.toBeNull()
    expect(loaded?.storage).toBe('sftp')
    expect(loaded?.sftp?.port).toBe(2222)
    expect(loaded?.sftp?.privateKey).toBe('-----BEGIN RSA PRIVATE KEY-----\n...')
  })

  it('should reject sftp bucket creation without sftp config', async () => {
    await expect(bucketService.create('sftp-bad', '/remote/path', 'sftp')).rejects.toThrow('sftp config is required')
  })

  it('should list both local and sftp buckets together', async () => {
    await bucketService.create('local-one', path.join(tempDir, 'local-one'))
    await bucketService.create('sftp-one', '/remote/sftp-one', 'sftp', {
      host: 'host',
      port: 22,
      username: 'u',
      password: 'p',
    })
    const all = await bucketService.list()
    const names = all.map(b => b.name)
    expect(names).toContain('local-one')
    expect(names).toContain('sftp-one')
  })
})


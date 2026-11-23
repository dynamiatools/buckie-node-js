import * as bcrypt from 'bcrypt'
import { readConfig, updateConfig } from '../config/config.service.js'
import type { Identity, Grant, Permission } from '../types/index.js'
import { BuckieError, BuckieErrorCode, notFound, conflict, badRequest } from '../errors/index.js'

export class IdentityService {
  constructor(private readonly dataDir: string) {}

  async create(identity: string, secret: string): Promise<Identity> {
    const hashedSecret = await bcrypt.hash(secret, 12)

    const now = new Date().toISOString()
    const id: Identity = {
      identity,
      hashedSecret,
      grants: [],
      createdAt: now,
      updatedAt: now,
    }

    await updateConfig(this.dataDir, cfg => {
      if (cfg.identities.some(i => i.identity === identity)) {
        throw conflict(`Identity '${identity}' already exists`, BuckieErrorCode.IDENTITY_ALREADY_EXISTS)
      }
      cfg.identities.push(id)
    })
    return id
  }

  async find(identity: string): Promise<Identity | null> {
    const cfg = await readConfig(this.dataDir)
    return cfg.identities.find(i => i.identity === identity) ?? null
  }

  async get(identity: string): Promise<Identity> {
    const id = await this.find(identity)
    if (!id) {
      throw notFound(`Identity '${identity}'`, BuckieErrorCode.IDENTITY_NOT_FOUND)
    }
    return id
  }

  async list(): Promise<Identity[]> {
    const cfg = await readConfig(this.dataDir)
    return cfg.identities
  }

  async verify(identity: string, secret: string): Promise<Identity | null> {
    const id = await this.find(identity)
    // Always run bcrypt, even for unknown identities, so response time
    // does not reveal which identities exist.
    const hash = id?.hashedSecret ?? await dummyHash()
    let valid = false
    try {
      valid = await bcrypt.compare(secret, hash)
    } catch {
      valid = false
    }
    return id && valid ? id : null
  }

  async grant(identity: string, grant: Grant): Promise<Identity> {
    for (const prefix of grant.prefixes ?? []) {
      if (typeof prefix !== 'string' || prefix.includes('\0') || prefix.split('/').includes('..')) {
        throw badRequest(`Invalid grant prefix: ${prefix}`, BuckieErrorCode.PREFIX_INVALID)
      }
    }

    return updateConfig(this.dataDir, cfg => {
      const id = cfg.identities.find(i => i.identity === identity)
      if (!id) throw notFound(`Identity '${identity}'`, BuckieErrorCode.IDENTITY_NOT_FOUND)

      id.grants = id.grants.filter(g => g.bucket !== grant.bucket)
      id.grants.push(grant)
      id.updatedAt = new Date().toISOString()
      return id
    })
  }

  async revoke(identity: string, bucket: string): Promise<Identity> {
    return updateConfig(this.dataDir, cfg => {
      const id = cfg.identities.find(i => i.identity === identity)
      if (!id) throw notFound(`Identity '${identity}'`, BuckieErrorCode.IDENTITY_NOT_FOUND)

      id.grants = id.grants.filter(g => g.bucket !== bucket)
      id.updatedAt = new Date().toISOString()
      return id
    })
  }

  async delete(identity: string): Promise<void> {
    await updateConfig(this.dataDir, cfg => {
      const before = cfg.identities.length
      cfg.identities = cfg.identities.filter(i => i.identity !== identity)
      if (cfg.identities.length === before) {
        throw notFound(`Identity '${identity}'`, BuckieErrorCode.IDENTITY_NOT_FOUND)
      }
    })
  }

  checkPermission(id: Identity, bucket: string, key: string, permission: Permission): Grant | null {
    for (const grant of id.grants) {
      if (grant.bucket !== bucket) continue
      if (!grant.permissions.includes(permission)) continue

      if (grant.prefixes.length === 0) return grant

      const normalizedKey = key.startsWith('/') ? key : `/${key}`
      for (const prefix of grant.prefixes) {
        const normalizedPrefix = prefix.startsWith('/') ? prefix : `/${prefix}`
        if (matchesPrefix(normalizedKey, normalizedPrefix)) return grant
      }
    }
    return null
  }
}

/**
 * Prefix match that respects path-segment boundaries: '/tenant-a' matches
 * '/tenant-a' and '/tenant-a/x' but never '/tenant-ab/x'.
 * A prefix ending in '/' is already a segment boundary.
 */
function matchesPrefix(key: string, prefix: string): boolean {
  if (prefix === '/') return true
  if (prefix.endsWith('/')) return key.startsWith(prefix)
  return key === prefix || key.startsWith(`${prefix}/`)
}

let dummyHashPromise: Promise<string> | undefined
function dummyHash(): Promise<string> {
  return (dummyHashPromise ??= bcrypt.hash('buckie-dummy-secret', 12))
}

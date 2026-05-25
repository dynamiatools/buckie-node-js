import * as bcrypt from 'bcrypt'
import { readConfig, writeConfig } from '../config/config.service.js'
import type { Identity, Grant, Permission } from '../types/index.js'
import { BuckieError, BuckieErrorCode, notFound, conflict } from '../errors/index.js'

export class IdentityService {
  constructor(private readonly dataDir: string) {}

  async create(identity: string, secret: string): Promise<Identity> {
    const existing = await this.find(identity)
    if (existing) {
      throw conflict(`Identity '${identity}' already exists`, BuckieErrorCode.IDENTITY_ALREADY_EXISTS)
    }

    const hashedSecret = await bcrypt.hash(secret, 12)

    const now = new Date().toISOString()
    const id: Identity = {
      identity,
      hashedSecret,
      grants: [],
      createdAt: now,
      updatedAt: now,
    }

    const cfg = await readConfig(this.dataDir)
    cfg.identities.push(id)
    await writeConfig(this.dataDir, cfg)
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
    if (!id) return null
    try {
      const valid = await bcrypt.compare(secret, id.hashedSecret)
      return valid ? id : null
    } catch {
      return null
    }
  }

  async grant(identity: string, grant: Grant): Promise<Identity> {
    const cfg = await readConfig(this.dataDir)
    const idx = cfg.identities.findIndex(i => i.identity === identity)
    if (idx < 0) throw notFound(`Identity '${identity}'`, BuckieErrorCode.IDENTITY_NOT_FOUND)

    const id = cfg.identities[idx]!
    id.grants = id.grants.filter(g => g.bucket !== grant.bucket)
    id.grants.push(grant)
    id.updatedAt = new Date().toISOString()
    await writeConfig(this.dataDir, cfg)
    return id
  }

  async revoke(identity: string, bucket: string): Promise<Identity> {
    const cfg = await readConfig(this.dataDir)
    const idx = cfg.identities.findIndex(i => i.identity === identity)
    if (idx < 0) throw notFound(`Identity '${identity}'`, BuckieErrorCode.IDENTITY_NOT_FOUND)

    const id = cfg.identities[idx]!
    id.grants = id.grants.filter(g => g.bucket !== bucket)
    id.updatedAt = new Date().toISOString()
    await writeConfig(this.dataDir, cfg)
    return id
  }

  async delete(identity: string): Promise<void> {
    const cfg = await readConfig(this.dataDir)
    const before = cfg.identities.length
    cfg.identities = cfg.identities.filter(i => i.identity !== identity)
    if (cfg.identities.length === before) {
      throw notFound(`Identity '${identity}'`, BuckieErrorCode.IDENTITY_NOT_FOUND)
    }
    await writeConfig(this.dataDir, cfg)
  }

  checkPermission(id: Identity, bucket: string, key: string, permission: Permission): Grant | null {
    for (const grant of id.grants) {
      if (grant.bucket !== bucket) continue
      if (!grant.permissions.includes(permission)) continue

      if (grant.prefixes.length === 0) return grant

      const normalizedKey = key.startsWith('/') ? key : `/${key}`
      for (const prefix of grant.prefixes) {
        const normalizedPrefix = prefix.startsWith('/') ? prefix : `/${prefix}`
        if (normalizedKey.startsWith(normalizedPrefix) || normalizedPrefix === '/') {
          return grant
        }
      }
    }
    return null
  }
}

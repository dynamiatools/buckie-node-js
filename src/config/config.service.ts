import path from 'node:path'
import fsp from 'node:fs/promises'
import type { BuckieConfig, BuckieConfigFile } from '../types/index.js'

/** Reported by `buckie --version`; keep in sync with package.json. */
export const VERSION = '1.1.0'

// Default data directory relative to CWD
const DEFAULT_DATA_DIR = path.join(process.cwd(), '.buckie')

export function getDataDir(): string {
  return process.env.BUCKIE_DATA_DIR ?? DEFAULT_DATA_DIR
}

export function getDefaultConfig(): BuckieConfig {
  return {
    dataDir: getDataDir(),
    // Loopback by default; pass --host / BUCKIE_HOST to expose the server (1.0.0 bound to 0.0.0.0).
    host: process.env.BUCKIE_HOST ?? '127.0.0.1',
    port: parseInt(process.env.BUCKIE_PORT ?? '8080', 10),
    logLevel: process.env.BUCKIE_LOG_LEVEL ?? 'info',
  }
}

/**
 * Maximum accepted upload size in bytes (`BUCKIE_MAX_UPLOAD_BYTES`).
 * 0 (the default) means unlimited, as in 1.0.0.
 */
export function getMaxUploadBytes(): number {
  const raw = process.env.BUCKIE_MAX_UPLOAD_BYTES
  return raw && /^\d+$/.test(raw) ? Number(raw) : 0
}

/**
 * Opt-in (`BUCKIE_FOLLOW_SYMLINKS=1`): follow symlinks inside a bucket even when they
 * point outside it. Only for operators who deliberately link other disks into a bucket.
 */
export function followExternalSymlinks(): boolean {
  return process.env.BUCKIE_FOLLOW_SYMLINKS === '1'
}

/** Opt-in (`BUCKIE_TRUST_PROXY=1`): trust X-Forwarded-For for the client IP. */
export function trustProxy(): boolean {
  return process.env.BUCKIE_TRUST_PROXY === '1'
}

/**
 * Returns the paths of the flat `.buckie/` directory layout:
 *   .buckie/config.json  — single source of truth
 *   .buckie/logs/        — JSONL access + error logs
 *   .buckie/cache/       — thumbnail cache + SFTP staging
 */
export function resolveDataPaths(dataDir: string) {
  return {
    dataDir,
    configFile: path.join(dataDir, 'config.json'),
    logsDir: path.join(dataDir, 'logs'),
    cacheDir: path.join(dataDir, 'cache'),
  }
}

export async function ensureDataDirs(dataDir: string): Promise<void> {
  const { logsDir, cacheDir } = resolveDataPaths(dataDir)
  await fsp.mkdir(dataDir, { recursive: true, mode: 0o700 })
  await fsp.mkdir(logsDir, { recursive: true, mode: 0o700 })
  await fsp.mkdir(cacheDir, { recursive: true, mode: 0o700 })
}

/**
 * Read the config. A missing or empty file yields an empty config; a corrupt file
 * throws, so callers never overwrite existing data with an empty config.
 */
export async function readConfig(dataDir: string): Promise<BuckieConfigFile> {
  const { configFile } = resolveDataPaths(dataDir)

  let raw: string
  try {
    raw = await fsp.readFile(configFile, 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { buckets: [], identities: [] }
    throw err
  }

  if (raw.trim() === '') return { buckets: [], identities: [] }

  let parsed: Partial<BuckieConfigFile> | null
  try {
    parsed = JSON.parse(raw) as Partial<BuckieConfigFile> | null
  } catch {
    throw new Error('Config file is not valid JSON; fix or restore it (Buckie will not overwrite it)')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Config file is not valid JSON; fix or restore it (Buckie will not overwrite it)')
  }

  return {
    buckets: parsed.buckets ?? [],
    identities: parsed.identities ?? [],
  }
}

/**
 * Atomic write (temp file + rename). A new file is private (0600); the mode of an
 * existing file is preserved, because the server may only be able to read it through it.
 */
export async function writeConfig(dataDir: string, config: BuckieConfigFile): Promise<void> {
  const { configFile } = resolveDataPaths(dataDir)
  await fsp.mkdir(dataDir, { recursive: true, mode: 0o700 })

  let mode = 0o600
  try {
    mode = (await fsp.stat(configFile)).mode & 0o777
  } catch {
    // new file
  }

  const tmp = `${configFile}.tmp.${process.pid}.${Date.now().toString(36)}`
  try {
    await fsp.writeFile(tmp, JSON.stringify(config, null, 2), { encoding: 'utf-8', mode, flag: 'wx' })
    await fsp.chmod(tmp, mode)
    await fsp.rename(tmp, configFile)
  } catch (err) {
    await fsp.unlink(tmp).catch(() => {})
    throw err
  }
}

// ── Locking ─────────────────────────────────────────────────────────────────

const LOCK_STALE_MS = 30_000
const LOCK_TIMEOUT_MS = 10_000
let inProcessQueue: Promise<unknown> = Promise.resolve()

async function acquireLock(lockDir: string): Promise<void> {
  const deadline = Date.now() + LOCK_TIMEOUT_MS
  for (;;) {
    try {
      await fsp.mkdir(lockDir) // atomic: fails with EEXIST while another process holds it
      return
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }
    try {
      const { mtimeMs } = await fsp.stat(lockDir)
      if (Date.now() - mtimeMs > LOCK_STALE_MS) {
        await fsp.rmdir(lockDir).catch(() => {}) // left behind by a crashed process
        continue
      }
    } catch {
      continue // released between mkdir and stat
    }
    if (Date.now() > deadline) throw new Error('Cannot lock config: timed out waiting for another Buckie process')
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

/**
 * Read-modify-write the config under an exclusive lock, so concurrent callers
 * (CLI + server, or several requests) cannot lose each other's changes.
 *
 * `mutate` changes the config in place and returns a result; if it throws, nothing is written.
 * All config changes must go through this function; never call `readConfig` + `writeConfig` by hand.
 */
export function updateConfig<T>(dataDir: string, mutate: (cfg: BuckieConfigFile) => T): Promise<T> {
  const run = async (): Promise<T> => {
    await fsp.mkdir(dataDir, { recursive: true, mode: 0o700 })
    const lockDir = `${resolveDataPaths(dataDir).configFile}.lock`
    await acquireLock(lockDir)
    try {
      const cfg = await readConfig(dataDir)
      const result = mutate(cfg)
      await writeConfig(dataDir, cfg)
      return result
    } finally {
      await fsp.rmdir(lockDir).catch(() => {})
    }
  }

  const next = inProcessQueue.then(run, run)
  inProcessQueue = next.catch(() => {})
  return next
}

// Legacy JSON helpers used by logging and internal utilities
export async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const content = await fsp.readFile(filePath, 'utf-8')
    return JSON.parse(content) as T
  } catch {
    return null
  }
}

export async function writeJsonFile<T>(filePath: string, data: T): Promise<void> {
  const dir = path.dirname(filePath)
  await fsp.mkdir(dir, { recursive: true })
  await fsp.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8')
}

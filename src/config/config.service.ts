import path from 'node:path'
import fsp from 'node:fs/promises'
import type { BuckieConfig, BuckieConfigFile } from '../types/index.js'

// Default data directory relative to CWD
const DEFAULT_DATA_DIR = path.join(process.cwd(), '.buckie')

export function getDataDir(): string {
  return process.env.BUCKIE_DATA_DIR ?? DEFAULT_DATA_DIR
}

export function getDefaultConfig(): BuckieConfig {
  return {
    dataDir: getDataDir(),
    host: process.env.BUCKIE_HOST ?? '0.0.0.0',
    port: parseInt(process.env.BUCKIE_PORT ?? '8080', 10),
    logLevel: process.env.BUCKIE_LOG_LEVEL ?? 'info',
  }
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
  await fsp.mkdir(dataDir, { recursive: true })
  await fsp.mkdir(logsDir, { recursive: true })
  await fsp.mkdir(cacheDir, { recursive: true })
}

const EMPTY_CONFIG: BuckieConfigFile = { buckets: [], identities: [] }

export async function readConfig(dataDir: string): Promise<BuckieConfigFile> {
  const { configFile } = resolveDataPaths(dataDir)
  try {
    const raw = await fsp.readFile(configFile, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<BuckieConfigFile>
    return {
      buckets: parsed.buckets ?? [],
      identities: parsed.identities ?? [],
    }
  } catch {
    return { buckets: [], identities: [] }
  }
}

export async function writeConfig(dataDir: string, config: BuckieConfigFile): Promise<void> {
  const { configFile } = resolveDataPaths(dataDir)
  await fsp.mkdir(dataDir, { recursive: true })
  await fsp.writeFile(configFile, JSON.stringify(config, null, 2), 'utf-8')
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

import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import { authPlugin } from './plugins/auth.plugin.js'
import { objectRoutes } from './routes/objects.route.js'
import type { BucketService } from '../storage/bucket.service.js'
import type { StorageService } from '../storage/storage.service.js'
import type { ThumbnailService } from '../thumbnail/thumbnail.service.js'
import type { IdentityService } from '../auth/identity.service.js'
import type { OperationalLogger } from '../logging/logger.js'
import { BuckieError } from '../errors/index.js'
import type { BuckieConfig } from '../types/index.js'

interface ServerOptions {
  config: BuckieConfig
  bucketService: BucketService
  storageService: StorageService
  thumbnailService: ThumbnailService
  identityService: IdentityService
  operationalLogger: OperationalLogger
}

export async function createServer(options: ServerOptions): Promise<FastifyInstance> {
  const { config, bucketService, storageService, thumbnailService, identityService, operationalLogger } = options

  const fastify = Fastify({
    logger: {
      level: config.logLevel,
      transport: process.env.NODE_ENV !== 'production'
        ? { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss Z', ignore: 'pid,hostname' } }
        : undefined,
    },
    disableRequestLogging: false,
  })

  // Register sensible for default error handling
  await fastify.register(import('@fastify/sensible'))

  // Error handler
  fastify.setErrorHandler((error, request, reply) => {
    if (error instanceof BuckieError) {
      return reply.status(error.statusCode).send(error.toJSON())
    }

    fastify.log.error(error)
    return reply.status(500).send({
      ok: false,
      error: {
        code: 'BUCKIE_INTERNAL_ERROR',
        message: process.env.NODE_ENV === 'production' ? 'Internal server error' : (error instanceof Error ? error.message : String(error)),
      },
    })
  })

  // Not found handler
  fastify.setNotFoundHandler((request, reply) => {
    return reply.status(404).send({
      ok: false,
      error: {
        code: 'BUCKIE_NOT_FOUND',
        message: `Route ${request.method} ${request.url} not found`,
      },
    })
  })

  // Health check (no auth)
  fastify.get('/health', async () => {
    return { ok: true, data: { status: 'healthy', uptime: process.uptime() } }
  })

  // Accept any Content-Type for upload routes.
  fastify.addContentTypeParser('*', (_request, _payload, done) => done(null))

  // Auth plugin (applies to all routes below)
  await fastify.register(authPlugin, { identityService, logger: operationalLogger })

  // Object routes
  await fastify.register(objectRoutes, {
    bucketService,
    storageService,
    thumbnailService,
    identityService,
    logger: operationalLogger,
  })

  return fastify
}

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import fp from 'fastify-plugin'
import { IdentityService } from '../../auth/identity.service.js'
import type { Identity } from '../../types/index.js'
import { BuckieError, BuckieErrorCode, unauthorized } from '../../errors/index.js'
import type { OperationalLogger } from '../../logging/logger.js'

declare module 'fastify' {
  interface FastifyRequest {
    authIdentity: Identity
  }
}

interface AuthPluginOptions {
  identityService: IdentityService
  logger: OperationalLogger
}

/**
 * Authentication plugin — reads credentials from:
 *   - X-Buckie-Identity + X-Buckie-Secret headers
 *   - HTTP Basic Auth (identity:secret)
 */
export const authPlugin = fp(async function authPlugin(
  fastify: FastifyInstance,
  options: AuthPluginOptions,
): Promise<void> {
  const { identityService, logger } = options

  fastify.decorateRequest<Identity | null>('authIdentity', null)

  fastify.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    // Skip health check
    if (request.url === '/health') return

    const identity = extractIdentity(request)
    const secret = extractSecret(request)

    if (!identity || !secret) {
      logger.logError('auth_failed', 'Missing credentials', { ip: request.ip })
      const err = unauthorized('Authentication required. Provide X-Buckie-Identity and X-Buckie-Secret headers.')
      return reply.status(err.statusCode).send(err.toJSON())
    }

    const id = await identityService.verify(identity, secret)
    if (!id) {
      logger.logError('auth_failed', 'Invalid credentials', { identity, ip: request.ip })
      const err = new BuckieError(BuckieErrorCode.AUTH_INVALID, 'Invalid credentials', 401)
      return reply.status(err.statusCode).send(err.toJSON())
    }

    request.authIdentity = id
  })
}, { name: 'buckie-auth' })

function extractIdentity(request: FastifyRequest): string | undefined {
  const headerIdentity = request.headers['x-buckie-identity']
  if (typeof headerIdentity === 'string' && headerIdentity) return headerIdentity

  const auth = request.headers.authorization
  if (auth?.startsWith('Basic ')) {
    const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf-8')
    const colonIdx = decoded.indexOf(':')
    if (colonIdx > 0) return decoded.slice(0, colonIdx)
  }

  return undefined
}

function extractSecret(request: FastifyRequest): string | undefined {
  const headerSecret = request.headers['x-buckie-secret']
  if (typeof headerSecret === 'string' && headerSecret) return headerSecret

  const auth = request.headers.authorization
  if (auth?.startsWith('Basic ')) {
    const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf-8')
    const colonIdx = decoded.indexOf(':')
    if (colonIdx >= 0) return decoded.slice(colonIdx + 1)
  }

  return undefined
}

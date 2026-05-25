// Buckie error codes and helpers

export enum BuckieErrorCode {
  // Auth
  AUTH_REQUIRED = 'BUCKIE_AUTH_REQUIRED',
  AUTH_INVALID = 'BUCKIE_AUTH_INVALID',
  PERMISSION_DENIED = 'BUCKIE_PERMISSION_DENIED',

  // Objects
  OBJECT_NOT_FOUND = 'BUCKIE_OBJECT_NOT_FOUND',
  OBJECT_IS_DIRECTORY = 'BUCKIE_OBJECT_IS_DIRECTORY',
  PATH_TRAVERSAL = 'BUCKIE_PATH_TRAVERSAL',
  PATH_INVALID = 'BUCKIE_PATH_INVALID',
  PATH_RESERVED = 'BUCKIE_PATH_RESERVED',

  // Buckets
  BUCKET_NOT_FOUND = 'BUCKIE_BUCKET_NOT_FOUND',
  BUCKET_ALREADY_EXISTS = 'BUCKIE_BUCKET_ALREADY_EXISTS',
  BUCKET_PATH_INVALID = 'BUCKIE_BUCKET_PATH_INVALID',
  BUCKET_PATH_NOT_WRITABLE = 'BUCKIE_BUCKET_PATH_NOT_WRITABLE',

  // Identities
  IDENTITY_NOT_FOUND = 'BUCKIE_IDENTITY_NOT_FOUND',
  IDENTITY_ALREADY_EXISTS = 'BUCKIE_IDENTITY_ALREADY_EXISTS',

  // Uploads
  UPLOAD_FAILED = 'BUCKIE_UPLOAD_FAILED',
  UPLOAD_STAGING_FAILED = 'BUCKIE_UPLOAD_STAGING_FAILED',

  // SFTP
  SFTP_CONNECTION_FAILED = 'BUCKIE_SFTP_CONNECTION_FAILED',
  SFTP_AUTH_FAILED = 'BUCKIE_SFTP_AUTH_FAILED',
  SFTP_OPERATION_FAILED = 'BUCKIE_SFTP_OPERATION_FAILED',

  // General
  INTERNAL_ERROR = 'BUCKIE_INTERNAL_ERROR',
  NOT_IMPLEMENTED = 'BUCKIE_NOT_IMPLEMENTED',
}

export interface BuckieErrorDetails {
  code: BuckieErrorCode
  message: string
  details?: Record<string, unknown>
}

export class BuckieError extends Error {
  public readonly code: BuckieErrorCode
  public readonly statusCode: number
  public readonly details?: Record<string, unknown>

  constructor(code: BuckieErrorCode, message: string, statusCode: number = 500, details?: Record<string, unknown>) {
    super(message)
    this.name = 'BuckieError'
    this.code = code
    this.statusCode = statusCode
    this.details = details
  }

  toJSON(): { ok: false; error: BuckieErrorDetails } {
    return {
      ok: false,
      error: {
        code: this.code,
        message: this.message,
        details: this.details,
      },
    }
  }
}

export function notFound(resource: string, code: BuckieErrorCode = BuckieErrorCode.OBJECT_NOT_FOUND): BuckieError {
  return new BuckieError(code, `${resource} not found`, 404)
}

export function forbidden(message: string, code: BuckieErrorCode = BuckieErrorCode.PERMISSION_DENIED): BuckieError {
  return new BuckieError(code, message, 403)
}

export function unauthorized(message: string = 'Authentication required'): BuckieError {
  return new BuckieError(BuckieErrorCode.AUTH_REQUIRED, message, 401)
}

export function badRequest(message: string, code: BuckieErrorCode = BuckieErrorCode.PATH_INVALID): BuckieError {
  return new BuckieError(code, message, 400)
}

export function conflict(message: string, code: BuckieErrorCode): BuckieError {
  return new BuckieError(code, message, 409)
}

export function internalError(message: string, details?: Record<string, unknown>): BuckieError {
  return new BuckieError(BuckieErrorCode.INTERNAL_ERROR, message, 500, details)
}

export function successResponse<T>(data: T): { ok: true; data: T } {
  return { ok: true, data }
}

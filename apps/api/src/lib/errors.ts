import { Context } from 'hono'
import { ZodError } from 'zod'

export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number = 400,
    public details?: unknown
  ) {
    super(message)
    this.name = 'AppError'
  }
}

export function errorHandler(err: Error, c: Context) {
  console.error(`[ERROR] ${err.message}`, err.stack)

  if (err instanceof AppError) {
    return c.json(
      { error: { code: err.code, message: err.message, details: err.details } },
      err.status as any
    )
  }

  if (err instanceof ZodError) {
    return c.json(
      {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid request data',
          details: err.errors,
        },
      },
      400
    )
  }

  return c.json(
    { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } },
    500
  )
}

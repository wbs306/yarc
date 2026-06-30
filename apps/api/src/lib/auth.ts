import { Context, Next } from 'hono'
import jwt from 'jsonwebtoken'
import bcrypt from 'bcryptjs'
import { config } from './config.js'

const JWT_EXPIRY = '7d'

export interface JWTPayload {
  sub: 'admin'
  iat: number
  exp: number
}

export function generateToken(): string {
  return jwt.sign({ sub: 'admin' }, config.jwtSecret, { expiresIn: JWT_EXPIRY })
}

export function verifyToken(token: string): JWTPayload | null {
  try {
    return jwt.verify(token, config.jwtSecret) as JWTPayload
  } catch {
    return null
  }
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10)
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash)
}

// Auth middleware
export function authMiddleware() {
  return async (c: Context, next: Next) => {
    // Check cookie first, then Authorization header
    const cookieToken = getCookie(c, 'yarc_token')
    const authHeader = c.req.header('Authorization')
    const headerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null
    const token = cookieToken || headerToken

    if (!token) {
      return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401)
    }

    const payload = verifyToken(token)
    if (!payload) {
      return c.json({ error: { code: 'UNAUTHORIZED', message: 'Invalid or expired token' } }, 401)
    }

    c.set('user', payload)
    await next()
  }
}

function getCookie(c: Context, name: string): string | undefined {
  const cookies = c.req.header('Cookie')
  if (!cookies) return undefined
  const match = cookies.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`))
  return match ? decodeURIComponent(match[1]) : undefined
}

export function setAuthCookie(c: Context, token: string) {
  c.header('Set-Cookie', `yarc_token=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${7 * 24 * 60 * 60}`)
}

export function clearAuthCookie(c: Context) {
  c.header('Set-Cookie', 'yarc_token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0')
}

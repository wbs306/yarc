import { Hono } from 'hono'
import { z } from 'zod'
import { generateToken, hashPassword, verifyPassword, verifyToken, setAuthCookie, clearAuthCookie, type JWTPayload } from '../lib/auth.js'
import { config } from '../lib/config.js'
import { prisma } from '@yarc/db'

const auth = new Hono()

const loginSchema = z.object({
  password: z.string().min(1),
})

// POST /api/auth/login
auth.post('/login', async (c) => {
  const body = await c.req.json()
  const { password } = loginSchema.parse(body)

  // Load persisted password hash when PASSWORD_HASH is not supplied by env.
  // Without this, every dev-server restart behaves like a first login.
  if (!config.passwordHash) {
    const saved = await prisma.setting.findUnique({ where: { key: 'password_hash' } })
    if (typeof saved?.value === 'string') config.passwordHash = saved.value
  }

  // Check if password hash exists
  if (!config.passwordHash) {
    // First login: set the password
    const hash = await hashPassword(password)
    config.passwordHash = hash
    // Save to settings
    await prisma.setting.upsert({
      where: { key: 'password_hash' },
      create: { key: 'password_hash', value: hash },
      update: { value: hash, updatedAt: new Date() },
    })
    const token = generateToken()
    setAuthCookie(c, token)
    return c.json({ token, message: 'Password set successfully' })
  }

  const valid = await verifyPassword(password, config.passwordHash)
  if (!valid) {
    return c.json({ error: { code: 'INVALID_PASSWORD', message: 'Invalid password' } }, 401)
  }

  const token = generateToken()
  setAuthCookie(c, token)
  return c.json({ token })
})

// POST /api/auth/logout
auth.post('/logout', (c) => {
  clearAuthCookie(c)
  return c.json({ message: 'Logged out' })
})

// GET /api/auth/me
auth.get('/me', async (c) => {
  const cookieToken = getCookie(c.req.header('Cookie'), 'yarc_token')
  const authHeader = c.req.header('Authorization')
  const headerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null
  const user = verifyToken(cookieToken || headerToken || '') as JWTPayload | null
  if (!user) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Not authenticated' } }, 401)
  }
  return c.json({ user: { id: user.sub } })
})

function getCookie(cookies: string | undefined, name: string): string | undefined {
  if (!cookies) return undefined
  const match = cookies.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`))
  return match ? decodeURIComponent(match[1]) : undefined
}

export default auth

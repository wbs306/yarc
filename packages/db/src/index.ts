import { PrismaClient } from '@prisma/client'

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://yarc:yarc@localhost:5432/yarc'

export const prisma = new PrismaClient({
  datasourceUrl: DATABASE_URL,
  log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
})

export * from '@prisma/client'

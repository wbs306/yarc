import type { ProjectHistorySettings } from '@yarc/shared'
import { AppError } from './errors.js'

export const DEFAULT_PROJECT_HISTORY_SETTINGS: ProjectHistorySettings = {
  enabled: true,
  include: ['**/*.tex', '**/*.bib', '**/*.sty', '**/*.cls', '**/*.bst'],
  exclude: [],
  idleDebounceSeconds: 30,
  maxIntervalSeconds: 120,
  retentionDays: 180,
  maxStorageMb: 512,
}

const stringPatterns = (value: unknown, field: string, fallback: string[]) => {
  if (value === undefined) return [...fallback]
  if (!Array.isArray(value) || value.length > 200 || value.some(item => typeof item !== 'string')) {
    throw new AppError('VALIDATION_ERROR', `${field} must be an array of strings`, 400)
  }
  return [...new Set(value.map(item => item.trim()).filter(Boolean))]
}

const boundedInteger = (value: unknown, field: string, fallback: number, min: number, max: number) => {
  if (value === undefined) return fallback
  const number = Number(value)
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new AppError('VALIDATION_ERROR', `${field} must be an integer between ${min} and ${max}`, 400)
  }
  return number
}

export const normalizeProjectHistorySettings = (
  value: unknown,
  fallback: ProjectHistorySettings = DEFAULT_PROJECT_HISTORY_SETTINGS,
): ProjectHistorySettings => {
  if (value === undefined || value === null) return { ...fallback, include: [...fallback.include], exclude: [...fallback.exclude] }
  if (typeof value !== 'object' || Array.isArray(value)) throw new AppError('VALIDATION_ERROR', 'History settings must be an object', 400)
  const input = value as Record<string, unknown>
  const enabled = input.enabled === undefined ? fallback.enabled : input.enabled
  if (typeof enabled !== 'boolean') throw new AppError('VALIDATION_ERROR', 'enabled must be a boolean', 400)

  const idleDebounceSeconds = boundedInteger(input.idleDebounceSeconds, 'idleDebounceSeconds', fallback.idleDebounceSeconds, 1, 3600)
  const maxIntervalSeconds = boundedInteger(input.maxIntervalSeconds, 'maxIntervalSeconds', fallback.maxIntervalSeconds, 1, 24 * 3600)
  if (maxIntervalSeconds < idleDebounceSeconds) {
    throw new AppError('VALIDATION_ERROR', 'maxIntervalSeconds must be greater than or equal to idleDebounceSeconds', 400)
  }

  return {
    enabled,
    include: stringPatterns(input.include, 'include', fallback.include),
    exclude: stringPatterns(input.exclude, 'exclude', fallback.exclude),
    idleDebounceSeconds,
    maxIntervalSeconds,
    retentionDays: boundedInteger(input.retentionDays, 'retentionDays', fallback.retentionDays, 1, 3650),
    maxStorageMb: boundedInteger(input.maxStorageMb, 'maxStorageMb', fallback.maxStorageMb, 1, 102400),
  }
}

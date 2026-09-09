import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  DEFAULT_PROJECT_HISTORY_SETTINGS,
  normalizeProjectHistorySettings,
} from '../lib/project-history-settings.js'

describe('normalizeProjectHistorySettings', () => {
  it('returns independent default arrays when no override is provided', () => {
    const first = normalizeProjectHistorySettings(undefined)
    const second = normalizeProjectHistorySettings(undefined)
    assert.deepEqual(first, DEFAULT_PROJECT_HISTORY_SETTINGS)
    assert.notEqual(first.include, second.include)
    assert.notEqual(first.exclude, second.exclude)
  })

  it('normalizes patterns and preserves validated numeric policy', () => {
    const settings = normalizeProjectHistorySettings({
      enabled: false,
      include: [' **/*.tex ', '**/*.tex', '**/*.bib'],
      exclude: ['generated/**', ''],
      idleDebounceSeconds: 15,
      maxIntervalSeconds: 90,
      retentionDays: 365,
      maxStorageMb: 1024,
    })
    assert.deepEqual(settings, {
      enabled: false,
      include: ['**/*.tex', '**/*.bib'],
      exclude: ['generated/**'],
      idleDebounceSeconds: 15,
      maxIntervalSeconds: 90,
      retentionDays: 365,
      maxStorageMb: 1024,
    })
  })

  it('rejects invalid timing and pattern values', () => {
    assert.throws(() => normalizeProjectHistorySettings({ idleDebounceSeconds: 60, maxIntervalSeconds: 30 }))
    assert.throws(() => normalizeProjectHistorySettings({ retentionDays: 0 }))
    assert.throws(() => normalizeProjectHistorySettings({ include: 'not-an-array' }))
    assert.throws(() => normalizeProjectHistorySettings({ enabled: 'yes' }))
  })
})

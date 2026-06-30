import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { dirname, join } from 'path'
import { config } from '../lib/config.js'

interface JournalRanking {
  ccf: {
    A: { journals: string[]; conferences: string[] }
    B: { journals: string[]; conferences: string[] }
    C: { journals: string[]; conferences: string[] }
  }
  sci: {
    Q1: string[]
    Q2: string[]
    Q3: string[]
    Q4: string[]
  }
}

export interface RankingEntry {
  name: string
  ccf: string | null
  sci: string | null
  custom?: boolean
}

export class RankingService {
  private rankings: JournalRanking | null = null
  private customCache: RankingEntry[] | null = null

  private loadRankings(): JournalRanking {
    if (!this.rankings) {
      try {
        const dataPath = join(import.meta.dirname, '../data/journal-rankings.json')
        const data = readFileSync(dataPath, 'utf-8')
        this.rankings = JSON.parse(data)
      } catch (err) {
        console.error('Failed to load journal rankings:', err)
        this.rankings = { ccf: { A: { journals: [], conferences: [] }, B: { journals: [], conferences: [] }, C: { journals: [], conferences: [] } }, sci: { Q1: [], Q2: [], Q3: [], Q4: [] } }
      }
    }
    return this.rankings!
  }

  private normalizeName(name: string): string {
    return name
      .toLowerCase()
      .replace(/&/g, ' and ')
      .replace(/ieee[-/]acm/g, 'ieee acm')
      .replace(/\b(the|an|a)\b/g, ' ')
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  }

  // Get CCF ranking for a journal or conference
  getCCFRanking(name: string): string | null {
    if (!name) return null
    
    const rankings = this.loadRankings()
    const normalizedName = this.normalizeName(name)
    
    for (const [level, data] of Object.entries(rankings.ccf)) {
      const allNames = [...data.journals, ...data.conferences]
      if (allNames.some(n => this.normalizeName(n) === normalizedName)) {
        return `CCF-${level}`
      }
    }
    
    return null
  }

  // Get SCI ranking for a journal
  getSCIRanking(name: string): string | null {
    if (!name) return null
    
    const rankings = this.loadRankings()
    const normalizedName = this.normalizeName(name)
    
    for (const [quartile, journals] of Object.entries(rankings.sci)) {
      if (journals.some(n => this.normalizeName(n) === normalizedName)) {
        return quartile
      }
    }
    
    return null
  }

  // Get all rankings for a journal or conference
  getRankings(name: string): { ccf: string | null; sci: string | null } {
    return {
      ccf: this.getCCFRanking(name),
      sci: this.getSCIRanking(name)
    }
  }

  // ── Custom mappings (stored as a local JSON file: data/custom-rankings.json) ──

  private customPath(): string {
    return join(config.dataDir, 'custom-rankings.json')
  }

  private async loadCustom(): Promise<RankingEntry[]> {
    if (this.customCache) return this.customCache
    try {
      const p = this.customPath()
      if (!existsSync(p)) {
        this.customCache = []
        return this.customCache
      }
      const raw = readFileSync(p, 'utf-8')
      const arr = JSON.parse(raw)
      this.customCache = Array.isArray(arr) ? (arr as RankingEntry[]) : []
    } catch {
      this.customCache = []
    }
    return this.customCache
  }

  async getCustom(): Promise<RankingEntry[]> {
    return [...(await this.loadCustom())]
  }

  async setCustom(list: RankingEntry[]): Promise<RankingEntry[]> {
    const clean = list
      .filter(e => e && typeof e.name === 'string' && e.name.trim())
      .map(e => ({ name: e.name.trim(), ccf: e.ccf || null, sci: e.sci || null, custom: true }))
    try {
      const p = this.customPath()
      mkdirSync(dirname(p), { recursive: true })
      writeFileSync(p, JSON.stringify(clean, null, 2) + '\n', 'utf-8')
    } catch (err) {
      console.error('Failed to persist custom rankings file:', err)
      throw err
    }
    this.customCache = clean
    return clean
  }

  // Rankings for a name, with custom mappings taking precedence over built-in.
  async getRankingsWithCustom(name: string): Promise<{ ccf: string | null; sci: string | null }> {
    const custom = await this.loadCustom()
    const normalizedName = this.normalizeName(name)
    const match = custom.find(e => this.normalizeName(e.name) === normalizedName)
    if (match) return { ccf: match.ccf, sci: match.sci }
    return this.getRankings(name)
  }

  // Flattened, deduped list of every mapping (built-in + custom). Custom overrides built-in.
  async getAllEntries(): Promise<RankingEntry[]> {
    const rankings = this.loadRankings()
    const map = new Map<string, RankingEntry>()
    const put = (name: string, patch: Partial<RankingEntry>) => {
      const key = this.normalizeName(name)
      const existing = map.get(key) || { name, ccf: null, sci: null }
      map.set(key, { ...existing, ...patch, name: existing.name })
    }
    for (const [level, data] of Object.entries(rankings.ccf)) {
      for (const n of [...data.journals, ...data.conferences]) put(n, { ccf: `CCF-${level}` })
    }
    for (const [quartile, journals] of Object.entries(rankings.sci)) {
      for (const n of journals) put(n, { sci: quartile })
    }
    for (const e of await this.loadCustom()) {
      map.set(this.normalizeName(e.name), { name: e.name, ccf: e.ccf || null, sci: e.sci || null, custom: true })
    }
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  // Search journals by name
  searchJournals(query: string, limit = 10): Array<{ name: string; ccf: string | null; sci: string | null }> {
    const rankings = this.loadRankings()
    const normalizedQuery = this.normalizeName(query)
    const results: Array<{ name: string; ccf: string | null; sci: string | null }> = []
    
    // Search in CCF rankings
    for (const [level, data] of Object.entries(rankings.ccf)) {
      for (const name of [...data.journals, ...data.conferences]) {
        if (this.normalizeName(name).includes(normalizedQuery)) {
          const sci = this.getSCIRanking(name)
          results.push({ name, ccf: `CCF-${level}`, sci })
        }
      }
    }
    
    // Search in SCI rankings
    for (const [quartile, journals] of Object.entries(rankings.sci)) {
      for (const name of journals) {
        if (this.normalizeName(name).includes(normalizedQuery)) {
          const ccf = this.getCCFRanking(name)
          if (!results.some(r => this.normalizeName(r.name) === this.normalizeName(name))) {
            results.push({ name, ccf, sci: quartile })
          }
        }
      }
    }
    
    return results.slice(0, limit)
  }
}

export const rankingService = new RankingService()

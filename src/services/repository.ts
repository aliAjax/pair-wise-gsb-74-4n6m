import type { GovernanceState } from '@/models/domain'
import { createSeedState } from '@/models/seed'
import { migrateState } from '@/services/migration'

const STORAGE_KEY = 'eventrail-governance-v1'

export const loadState = (): GovernanceState => {
  const raw = localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    const seed = migrateState(createSeedState())
    localStorage.setItem(STORAGE_KEY, JSON.stringify(seed))
    return seed
  }
  try {
    const parsed = migrateState(JSON.parse(raw) as GovernanceState)
    // 迁移补全后回写一次，保证下次加载结构完整
    localStorage.setItem(STORAGE_KEY, JSON.stringify(parsed))
    return parsed
  } catch {
    const seed = migrateState(createSeedState())
    localStorage.setItem(STORAGE_KEY, JSON.stringify(seed))
    return seed
  }
}

export const saveState = (state: GovernanceState): void => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(structuredClone(state)))
}

export const resetState = (): GovernanceState => {
  const seed = migrateState(createSeedState())
  saveState(seed)
  return seed
}

export const createId = (prefix: string): string =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`

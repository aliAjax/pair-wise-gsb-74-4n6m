import type { GovernanceState } from '@/models/domain'
import { GOVERNANCE_SCHEMA_VERSION } from '@/models/domain'
import { createSeedState } from '@/models/seed'
import { migrateGovernanceState } from '@/services/migration'
import { createId } from '@/services/id'

export { createId }

const STORAGE_KEY = 'eventrail-governance-v1'

type StateListener = (state: GovernanceState) => void
const listeners = new Set<StateListener>()

const withVersion = (state: GovernanceState): GovernanceState => ({
  ...state,
  publications: state.publications ?? [],
  schemaVersion: state.schemaVersion ?? GOVERNANCE_SCHEMA_VERSION,
  simulateNextPublishFailure: state.simulateNextPublishFailure ?? false,
})

export const loadState = (): GovernanceState => {
  const raw = localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    const seed = createSeedState()
    localStorage.setItem(STORAGE_KEY, JSON.stringify(seed))
    return seed
  }
  try {
    const parsed = withVersion(JSON.parse(raw) as GovernanceState)
    // 历史数据没有端批次时，按当时平台规则兼容回填后再落盘
    const needsMigration =
      parsed.schemaVersion < GOVERNANCE_SCHEMA_VERSION ||
      parsed.releases.some((release) => !release.batches || release.batches.length === 0) ||
      !parsed.publications
    if (!needsMigration) return parsed
    const migrated = migrateGovernanceState(parsed)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(migrated))
    return migrated
  } catch {
    const seed = createSeedState()
    localStorage.setItem(STORAGE_KEY, JSON.stringify(seed))
    return seed
  }
}

export const saveState = (state: GovernanceState): void => {
  let snapshot: GovernanceState
  try {
    snapshot = structuredClone(withVersion(state))
  } catch {
    // 个别运行时对响应式代理的结构化克隆支持不一致，状态本身为纯 JSON 数据，回退安全
    snapshot = JSON.parse(JSON.stringify(withVersion(state))) as GovernanceState
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot))
}

export const resetState = (): GovernanceState => {
  const seed = createSeedState()
  saveState(seed)
  return seed
}

/** 订阅其它浏览器窗口写入的最新状态（用于跨窗口并发提交冲突感知） */
export const subscribeState = (listener: StateListener): (() => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== STORAGE_KEY || !event.newValue) return
    try {
      const state = withVersion(JSON.parse(event.newValue) as GovernanceState)
      listeners.forEach((listener) => listener(state))
    } catch {
      // 忽略无法解析的跨窗口数据
    }
  })
}

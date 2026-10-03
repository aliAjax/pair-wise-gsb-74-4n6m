/* store 层验证：发布失败重试幂等、乐观锁冲突、规则变更只重算受影响端、按端回滚隔离 */
import assert from 'node:assert'
// Node 的 structuredClone 不能克隆 Pinia/Vue 响应式代理（浏览器环境正常），测试用 JSON 深拷贝桩
globalThis.structuredClone = <T>(value: T): T =>
  JSON.parse(JSON.stringify(value ?? null)) as T
import { useGovernanceStore } from '../src/stores/governance'
import { createPinia, setActivePinia } from 'pinia'
import { createSeedState } from '../src/models/seed'

// localStorage 桩
const backingStore = new Map<string, string>()
;(globalThis as { localStorage: Storage }).localStorage = {
  getItem: (key: string) => backingStore.get(key) ?? null,
  setItem: (key: string, value: string) => {
    backingStore.set(key, value)
  },
  removeItem: (key: string) => {
    backingStore.delete(key)
  },
  clear: () => backingStore.clear(),
  key: () => null,
  length: 0,
} as Storage
// window backingStore 事件桩
const listeners = new Set<(event: StorageEvent) => void>()
;(globalThis as { window?: unknown }).window = {
  addEventListener: (_: string, listener: (event: StorageEvent) => void) => listeners.add(listener),
}
backingStore.clear()
backingStore.set('eventrail-governance-v1', JSON.stringify(createSeedState()))

setActivePinia(createPinia())
const store = useGovernanceStore()

const results: Array<{ name: string; ok: boolean; error?: string }> = []
const test = (name: string, fn: () => void): void => {
  try {
    fn()
    results.push({ name, ok: true })
  } catch (error) {
    results.push({ name, ok: false, error: error instanceof Error ? error.message : String(error) })
  }
}

const getBatch = (version: string, platform: string) => {
  const release = store.data.releases.find((item) => item.version === version)!
  return { release, batch: release.batches.find((b) => b.platform === platform)! }
}

test('写入失败：批次停留未完成态，同 attemptId 重试成功且只产生一条台账', () => {
  const { release, batch } = getBatch('2026.10.0', 'web')
  const ledgerBefore = store.data.publications.length
  store.setSimulateNextPublishFailure(true)

  const first = store.publishBatch(batch.id, 'attempt-web-1')
  assert.strictEqual(first.ok, false)
  assert.strictEqual(first.reason, 'write_failed')
  const failed = store.data.releases
    .find((r) => r.id === release.id)!
    .batches.find((b) => b.id === batch.id)!
  assert.strictEqual(failed.status, 'publish_failed')
  assert.strictEqual(failed.lastAttemptId, 'attempt-web-1')
  assert.strictEqual(store.data.publications.length, ledgerBefore, '失败不写台账')

  // 同一未完成批次重试（同一 attemptId）
  const retry = store.publishBatch(batch.id, 'attempt-web-1')
  assert.strictEqual(retry.ok, true)
  assert.strictEqual(store.data.publications.length, ledgerBefore + 1, '只新增一条台账')
  const after = store.data.releases
    .find((r) => r.id === release.id)!
    .batches.find((b) => b.id === batch.id)!
  assert.strictEqual(after.status, 'published')
  assert.ok(after.publishedAt)

  // 再用同 attemptId 调用一次：幂等返回，不再新增
  const idem = store.publishBatch(batch.id, 'attempt-web-1')
  assert.strictEqual(idem.ok, true)
  assert.strictEqual(store.data.publications.length, ledgerBefore + 1)
})

test('乐观锁：后到窗口 revision 不符时提交被拒，本端数据不被覆盖', () => {
  const { batch } = getBatch('2026.10.0', 'ios')
  const staleRevision = batch.revision
  // 模拟另一窗口先提交（直接推进 revision）
  const other = store.confirmBatchMigration(
    batch.id,
    batch.migrationConfirmations[1]!.id,
    '其它窗口确认人',
    '其它窗口先确认了迁移',
    staleRevision,
  )
  assert.strictEqual(other.ok, true)

  // 本窗口拿旧 revision 提交审批 -> 冲突
  const conflict = store.updateBatchApproval(
    batch.id,
    'product',
    'approved',
    '丁禾',
    '本窗口迟到的审批',
    staleRevision,
  )
  assert.strictEqual(conflict.ok, false)
  assert.strictEqual(conflict.reason, 'conflict')
  const current = store.data.releases
    .flatMap((r) => r.batches)
    .find((b) => b.id === batch.id)!
  const product = current.approvals.find((a) => a.role === 'product')!
  assert.notStrictEqual(product.comment, '本窗口迟到的审批')
  assert.ok(store.externalUpdate, '应记录冲突横幅信息')
})

test('平台规则保存后只重算该端非终态批次', () => {
  const { batch: ios } = getBatch('2026.10.0', 'ios')
  const iosRevision = ios.revision
  const event = store.data.events.find((item) => item.id === 'evt-003')!
  const rule = event.platformRules.find((item) => item.platform === 'ios')!
  store.savePlatformRule('evt-003', { ...rule, trigger: 'iOS 新触发口径（仅 iOS）' })
  const iosAfter = store.data.releases
    .flatMap((r) => r.batches)
    .find((b) => b.id === ios.id)!
  assert.ok(iosAfter.revision >= iosRevision)
  const recomputedPlatforms = store.data.audit
    .filter((a) => a.action === '重算受影响端批次')
    .map((a) => a.detail)
  const latest = recomputedPlatforms[0] ?? ''
  assert.ok(latest.includes('ios'), `重算应只含 ios，实际：${latest}`)
  assert.ok(!latest.includes('web'), `不应重算 web，实际：${latest}`)
})

test('按端回滚只回滚目标端，其它端仍已发布', () => {
  // web 已在前面发布；构造另一个已发布端 ios 不现实（门禁未齐），
  // 这里直接验证 executeRollback 对 web 批次的隔离效果
  const { release, batch: web } = getBatch('2026.10.0', 'web')
  const rollbackCount = store.data.rollbacks.length
  store.executeRollback(
    release.id,
    'Web 端上报格式异常',
    'Web 4.2.0 至 4.2.1',
    'WEB-INCIDENT-1',
    web.id,
  )
  const after = store.data.releases
    .find((r) => r.id === release.id)!
    .batches.find((b) => b.id === web.id)!
  assert.strictEqual(after.status, 'rolled_back')
  const record = store.data.rollbacks[0]!
  assert.strictEqual(record.platform, 'web')
  assert.strictEqual(record.batchId, web.id)
  assert.strictEqual(store.data.rollbacks.length, rollbackCount + 1)
  // 历史发布 rel-000 的所有端批次保持已发布，不受这次回滚牵连
  const legacy = store.data.releases.find((r) => r.version === '2026.09.0')!
  assert.ok(legacy.batches.every((b) => b.status === 'published'))
})

let failed = 0
for (const result of results) {
  if (result.ok) console.log(`  ✓ ${result.name}`)
  else {
    failed += 1
    console.log(`  ✗ ${result.name}\n    ${result.error}`)
  }
}
console.log(`\n${results.length - failed}/${results.length} passed`)
if (failed > 0) process.exit(1)

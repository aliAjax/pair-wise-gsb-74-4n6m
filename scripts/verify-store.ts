/* store 端到端：幂等发布重试 + 多窗口冲突草稿 */
import assert from 'node:assert'
import { createPinia, setActivePinia } from 'pinia'
import { createSeedState } from '@/models/seed'
import { migrateState } from '@/services/migration'
import { saveState } from '@/services/repository'
import { useGovernanceStore } from '@/stores/governance'

// localStorage polyfill（node 环境）
class MemoryStorage {
  private map = new Map<string, string>()
  getItem(key: string) {
    return this.map.has(key) ? this.map.get(key)! : null
  }
  setItem(key: string, value: string) {
    this.map.set(key, value)
  }
  removeItem(key: string) {
    this.map.delete(key)
  }
}
;(globalThis as unknown as { localStorage: MemoryStorage }).localStorage = new MemoryStorage()
;(globalThis as unknown as { window: unknown }).window = { addEventListener() {}, removeEventListener() {} }
// node 环境下 structuredClone 不能克隆 Pinia 响应式代理，用 JSON 深拷贝等价替代
;(globalThis as unknown as { structuredClone: (v: unknown) => unknown }).structuredClone = (
  value: unknown,
) => JSON.parse(JSON.stringify(value) as string)

saveState(migrateState(createSeedState()))
setActivePinia(createPinia())
const store = useGovernanceStore()

const release = store.data.releases.find((r) => r.id === 'rel-001')!
const webBatch = release.batches!.find((b) => b.platform === 'web')!
const auditBefore = store.data.audit.length
const baselinesBefore = store.data.baselines.length

// 1. 首次写入失败
store.armNextWriteFailure()
const failed = await store.writeBatchPublish(release.id, webBatch.id)
assert.equal(failed.status, 'failed', '首次写入应失败')
assert.equal(webBatch.writeState, 'failed', '批次应停留 failed')
assert.equal(webBatch.status, 'publishing', '批次状态停留 publishing')
assert.equal(webBatch.writeAttempts, 1, '应记录 1 次尝试')
assert.ok(webBatch.publishKey, '失败也应已分配幂等键')
console.log('✓ 写入失败：批次停留未完成状态，等待重试')

// 2. 重试成功：基线只落一份，发布记录只生成一条
const success = await store.writeBatchPublish(release.id, webBatch.id)
assert.equal(success.status, 'published', '重试应成功')
assert.equal(webBatch.status, 'published')
assert.equal(webBatch.writeAttempts, 2, '应记录 2 次尝试')
const publishAudits = store.data.audit.filter(
  (a) => a.action === '发布端批次' && a.entityId === webBatch.id,
)
assert.equal(publishAudits.length, 1, '只能有一条成功发布记录')
// 每个事件一份端基线
const webBaselines = store.data.baselines.filter(
  (b) => b.platform === 'web' && b.batchId === webBatch.id,
)
assert.equal(webBaselines.length, webBatch.eventIds.length, '每事件一份端基线')
console.log('✓ 失败后重试成功，发布记录与端基线均未重复生成')

// 3. 再次调用（重复点击）幂等返回
const again = await store.writeBatchPublish(release.id, webBatch.id)
assert.equal(again.status, 'published')
assert.equal(
  store.data.audit.filter((a) => a.action === '发布端批次' && a.entityId === webBatch.id).length,
  1,
  '重复调用不产生新记录',
)
assert.equal(
  store.data.baselines.filter((b) => b.batchId === webBatch.id).length,
  webBatch.eventIds.length,
  '重复调用不产生新基线',
)
void auditBefore
void baselinesBefore
console.log('✓ 重复发布调用幂等，绝不重复生成发布记录')

// 4. 多窗口冲突：后到方基于旧 revision 提交 → 保留草稿并冲突
const iosBatch = release.batches!.find((b) => b.platform === 'ios')!
const baseRevision = iosBatch.revision
// 先到方先提交一次，推进 revision
const first = store.submitBatchDraft(release.id, iosBatch.id, iosBatch.eventIds, baseRevision)
assert.equal(first.status, 'submitted')
assert.equal(iosBatch.revision, baseRevision + 1, '先到方应推进修订号')
// 后到方仍基于旧修订号提交
const second = store.submitBatchDraft(release.id, iosBatch.id, iosBatch.eventIds, baseRevision)
assert.equal(second.status, 'conflict', '后到方应检测到冲突')
assert.ok(iosBatch.draftConflict, '后到方草稿应被保留')
assert.equal(iosBatch.draftConflict?.baseRevision, baseRevision)
assert.equal(iosBatch.revision, baseRevision + 1, '冲突提交不应推进修订号')
console.log('✓ 两窗口并发提交同一端：后到方保留草稿并看到冲突提示')

// 5. 按端回滚不牵连其他端
const serverBatch = release.batches!.find((b) => b.platform === 'server')!
// server 门禁齐备，直接发布
const serverPub = await store.writeBatchPublish(release.id, serverBatch.id)
assert.equal(serverPub.status, 'published')
const record = store.executeRollback(
  release.id,
  'web 异常',
  'Web 端',
  'EV-1',
  webBatch.id,
)!
assert.ok(record, '应生成回滚记录')
assert.equal(webBatch.status, 'rolled_back', 'web 应回滚')
assert.equal(serverBatch.status, 'published', 'server 不受牵连仍发布')
const rollbacksForBatch = store.data.rollbacks.filter((r) => r.batchId === webBatch.id)
assert.equal(rollbacksForBatch.length, 1)
console.log('✓ 按端回滚只影响该端，其他稳定端保持已发布')

console.log('\nstore 端到端验证全部通过 ✅')

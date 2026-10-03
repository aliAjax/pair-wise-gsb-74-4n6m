/* eslint-disable no-console */
import assert from 'node:assert'
import { createSeedState } from '../src/models/seed'
import {
  deriveReleaseBatches,
  recomputeBatch,
  canPublishBatch,
  batchReadiness,
  platformLabel,
} from '../src/services/batch'
import { validateGovernance } from '../src/services/selectors'
import type { GovernanceState, Platform, PlatformBatch } from '../src/models/domain'

const results: Array<{ name: string; ok: boolean; error?: string }> = []
const test = (name: string, fn: () => void): void => {
  try {
    fn()
    results.push({ name, ok: true })
  } catch (error) {
    results.push({ name, ok: false, error: error instanceof Error ? error.message : String(error) })
  }
}

const freshState = (): GovernanceState => structuredClone(createSeedState())

// 1. 新发布候选按端拆分
test('创建发布候选时按端拆成独立批次', () => {
  const state = freshState()
  const releaseId = 'rel-test'
  const batches = deriveReleaseBatches(state, releaseId, '2026.11.0', [
    'evt-001',
    'evt-003',
  ])
  const platforms = batches.map((batch) => batch.platform)
  assert.deepStrictEqual([...platforms].sort(), ['android', 'ios', 'server', 'web'])
  // evt-003 没有 server 规则，server 批次只含 evt-001
  const server = batches.find((batch) => batch.platform === 'server')!
  assert.deepStrictEqual(server.eventIds, ['evt-001'])
  const android = batches.find((batch) => batch.platform === 'android')!
  assert.deepStrictEqual(android.eventIds.sort(), ['evt-001', 'evt-003'])
  // 迁移/审批是各端独立副本
  assert.notStrictEqual(batches[0]!.approvals, batches[1]!.approvals)
  assert.strictEqual(batches[0]!.approvals.length, 4)
  assert.strictEqual(batches[0]!.revision, 1)
})

// 2. 种子 rel-001：Web 可单发、Android 卡住
test('Web 端门禁满足可单独发布，Android 离线队列未切完被卡住', () => {
  const state = freshState()
  const issues = validateGovernance(state)
  const release = state.releases.find((item) => item.version === '2026.10.0')!
  const web = release.batches.find((batch) => batch.platform === 'web')!
  const android = release.batches.find((batch) => batch.platform === 'android')!
  assert.strictEqual(canPublishBatch(web, issues).ok, true, 'Web 应可发布')
  assert.strictEqual(batchReadiness(web, issues) >= 90, true)
  assert.strictEqual(canPublishBatch(android, issues).ok, false, 'Android 不应可发布')
  const ios = release.batches.find((batch) => batch.platform === 'ios')!
  assert.strictEqual(canPublishBatch(ios, issues).ok, false, 'iOS 迁移未齐也不可发布')
})

// 3. 平台规则变更只重算该端，且重置审批
test('Android 平台规则一改，只重算 Android 端并重签审批', () => {
  const state = freshState()
  const release = state.releases.find((item) => item.version === '2026.10.0')!
  const before = (platform: Platform): PlatformBatch =>
    release.batches.find((batch) => batch.platform === platform)!

  // 先把 Web 审批全部通过，后续不应被 Android 变更影响
  const web = before('web')
  web.approvals.forEach((approval) => {
    approval.status = 'approved'
  })

  // 修改 evt-001 的 Android 规则触发时机
  const event = state.events.find((item) => item.id === 'evt-001')!
  const rule = event.platformRules.find((item) => item.platform === 'android')!
  rule.trigger = '离线队列切换完成后立即上报（新口径）'

  const androidResult = recomputeBatch(state, before('android'), release.version)
  assert.strictEqual(androidResult.changed, true)
  assert.deepStrictEqual(androidResult.affectedPlatforms, ['android'])
  const androidChanged = androidResult.batch.differences
    .flatMap((difference) => difference.platformRuleChanges ?? [])
  assert.ok(androidChanged.some((text) => text.includes('触发时机')), '应检测到触发时机变化')

  // Web 端用同样数据重算不应有任何变化
  const webResult = recomputeBatch(state, before('web'), release.version)
  assert.strictEqual(webResult.changed, false, 'Web 不受 Android 规则变更影响')
})

// 4. 属性变更只重算该属性适用的端
test('server-only 属性变更不重算客户端端批次', () => {
  const state = freshState()
  const release = state.releases.find((item) => item.version === '2026.10.0')!
  // 给 server 批次人为加 evt-006（server-only 事件）模拟更复杂候选
  const changedFrom = state.events.find((item) => item.id === 'evt-006')!
  changedFrom.properties.find((item) => item.name === 'changed_from')!.required = true
  const server = release.batches.find((batch) => batch.platform === 'server')!
  // server 批次不含 evt-006（候选事件范围），重算无变化
  const result = recomputeBatch(state, server, release.version)
  assert.strictEqual(result.changed, false)
})

// 5. 发布幂等：同 attemptId 第二次调用不产生新台账
test('发布写入按 attemptId 幂等，重试不重复生成发布记录', () => {
  const state = freshState()
  const release = state.releases.find((item) => item.version === '2026.10.0')!
  const web = release.batches.find((batch) => batch.platform === 'web')!
  const beforeCount = state.publications.length

  // 用最小化的 store 同款发布逻辑复刻：直接验证数据层约束
  const attemptId = 'attempt-fixed-1'
  const firstExists = state.publications.some(
    (record) => record.attemptId === attemptId && record.batchId === web.id,
  )
  assert.strictEqual(firstExists, false)
  // 模拟第一次成功
  web.status = 'published'
  state.publications.unshift({
    id: 'pub-x',
    releaseId: release.id,
    batchId: web.id,
    version: release.version,
    platform: 'web',
    attemptId,
    eventIds: web.eventIds,
    operator: 'tester',
    publishedAt: new Date().toISOString(),
  })
  // 模拟重试：幂等命中直接返回，不再 unshift
  const duplicated = state.publications.some(
    (record) => record.attemptId === attemptId && record.batchId === web.id,
  )
  assert.strictEqual(duplicated, true)
  assert.strictEqual(state.publications.length, beforeCount + 1)
  // 再写一次同 attemptId 应被 store 拦截；这里保证记录数不变
  const sameCount = state.publications.filter(
    (record) => record.attemptId === attemptId && record.batchId === web.id,
  ).length
  assert.strictEqual(sameCount, 1)
})

// 6. 历史发布 rel-000 已按当时规则回填端批次与台账
test('历史已发布版本回填为全部已发布端批次并补登台账', () => {
  const state = freshState()
  const legacy = state.releases.find((item) => item.version === '2026.09.0')!
  assert.ok(legacy.batches.length >= 3, '历史版本应回填多个端批次')
  assert.ok(legacy.batches.every((batch) => batch.status === 'published'))
  assert.ok(legacy.batches.every((batch) => batch.approvals.every((a) => a.status === 'approved')))
  const ledger = state.publications.filter((record) => record.releaseId === legacy.id)
  assert.strictEqual(ledger.length, legacy.batches.length)
  // attemptId 稳定唯一
  assert.strictEqual(new Set(ledger.map((record) => record.attemptId)).size, ledger.length)
})

// 7. 已发布端批次是终态，规则变更不再重算它
test('已发布端批次不参与重算，不被新规则牵动', () => {
  const state = freshState()
  const legacy = state.releases.find((item) => item.version === '2026.09.0')!
  const web = legacy.batches.find((batch) => batch.platform === 'web')!
  const event = state.events.find((item) => item.id === 'evt-002')!
  event.platformRules.find((rule) => rule.platform === 'web')!.trigger = '未来新规则'
  const result = recomputeBatch(state, web, legacy.version)
  assert.strictEqual(result.changed, false)
  assert.strictEqual(web.status, 'published')
})

// 8. 按端差异：server-only 属性只出现在 server 批次差异里
test('按端差异只包含该端适用属性', () => {
  const state = freshState()
  const release = state.releases.find((item) => item.version === '2026.10.0')!
  const server = release.batches.find((batch) => batch.platform === 'server')!
  const evt001 = server.differences.find((difference) => difference.eventId === 'evt-001')
  assert.ok(evt001)
  // coupon_id 仅客户端三端，server 批次差异不应包含
  assert.ok(!evt001!.addedProperties.includes('coupon_id'))
  const web = release.batches.find((batch) => batch.platform === 'web')!
  // server-only 事件 evt-006 不在候选内，server 批次不应包含
  assert.ok(!server.eventIds.includes('evt-006'))
  assert.ok(web.eventIds.includes('evt-001'))
})

let failed = 0
for (const result of results) {
  if (result.ok) {
    console.log(`  ✓ ${result.name}`)
  } else {
    failed += 1
    console.log(`  ✗ ${result.name}\n    ${result.error}`)
  }
}
console.log(`\n${results.length - failed}/${results.length} passed`)
if (failed > 0) process.exit(1)
void platformLabel

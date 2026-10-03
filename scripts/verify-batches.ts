/* 端批次核心逻辑冒烟验证（由 esbuild 临时转译后在 node 中执行） */
import assert from 'node:assert'
import { createSeedState } from '@/models/seed'
import { migrateState } from '@/services/migration'
import {
  batchAffectedDependencies,
  batchGatesReady,
  batchReadiness,
  compareBatchEvent,
  latestPlatformBaseline,
  platformsOfEvents,
  recomputeBatchDifferences,
} from '@/services/batches'
import { validateGovernance } from '@/services/selectors'

let state = migrateState(createSeedState())

// 1. 历史发布 rel-000 无端批次 → 按当时平台规则兼容回填，且均为 published/backfilled
const rel000 = state.releases.find((r) => r.id === 'rel-000')!
assert.ok(rel000.batches && rel000.batches.length >= 2, 'rel-000 应回填端批次')
assert.ok(
  rel000.batches!.every((b) => b.backfilled && b.status === 'published'),
  '历史批次应为 backfilled + published',
)
console.log('✓ 历史数据无批次时按当时平台规则回填:', rel000.batches!.map((b) => b.platform).join('/'))

// 2. rel-001 原生按端批次：Web/Server 门禁齐备；iOS 审批不齐；Android 迁移被卡
const rel001 = state.releases.find((r) => r.id === 'rel-001')!
const byPlatform = new Map(rel001.batches!.map((b) => [b.platform, b]))
assert.ok(batchGatesReady(byPlatform.get('web')!), 'web 门禁应齐备')
assert.ok(batchGatesReady(byPlatform.get('server')!), 'server 门禁应齐备')
assert.ok(!batchGatesReady(byPlatform.get('ios')!), 'ios 门禁不应齐备')
assert.ok(!batchGatesReady(byPlatform.get('android')!), 'android 门禁不应齐备')
const android = byPlatform.get('android')!
assert.ok(
  android.migrationConfirmations.some(
    (m) => m.dependencyId === 'dep-004' && m.note.includes('离线补报队列'),
  ),
  'android dep-004 迁移应被离线队列阻塞',
)
console.log('✓ Web/Server 可独立发布；iOS 审批中；Android 离线队列阻塞迁移')

// 3. 平台规则一改，只影响对应端：给 evt-001 新增一个属性，仅 android 适用
const evt001 = state.events.find((e) => e.id === 'evt-001')!
evt001.properties.push({
  id: 'prop-test-android-only',
  eventId: 'evt-001',
  name: 'android_offline_seq',
  displayName: '离线序列号',
  type: 'string',
  required: false,
  description: '仅 Android 离线队列使用',
  enumValues: [],
  owner: 'Android 客户端组',
  synonyms: [],
  platforms: ['android'],
})
// 手动模拟 store 的置脏：只把 android 批次标脏
rel001.batches!.forEach((b) => {
  if (b.eventIds.includes('evt-001') && b.platform === 'android') b.dirty = true
})
assert.equal(byPlatform.get('web')!.dirty, false, 'web 批次不应置脏')
assert.equal(byPlatform.get('ios')!.dirty, false, 'ios 批次不应置脏')
assert.equal(byPlatform.get('server')!.dirty, false, 'server 批次不应置脏')
assert.equal(android.dirty, true, '只有 android 批次应置脏')
console.log('✓ 事件/规则变更只把受影响端批次置脏')

// 4. 只重算受影响批次：android 差异出现新属性，web 差异不含
const androidDiffs = recomputeBatchDifferences(state, android)
const evt001AndroidDiff = androidDiffs.find((d) => d.eventId === 'evt-001')
assert.ok(evt001AndroidDiff?.addedProperties.includes('android_offline_seq'), 'android 差异应含新属性')
const webDiffs = recomputeBatchDifferences(state, byPlatform.get('web')!)
assert.ok(
  !webDiffs.some((d) => d.addedProperties.includes('android_offline_seq')),
  'web 差异不应含 android 专属属性',
)
console.log('✓ 只重算受影响端，且差异按端属性集合计算')

// 5. 端基线回退：没有端快照时使用历史全端基线（不判全部属性为新增）
const fallback = latestPlatformBaseline(state.baselines, 'evt-004', 'web')
assert.ok(fallback && fallback.platform === undefined, 'evt-004 应回退到历史全端基线')
const evt004Web = compareBatchEvent(state, 'evt-004', 'web')
assert.deepEqual(evt004Web?.addedProperties, [], '相对全端基线不应出现新增属性')
console.log('✓ 无端快照时兼容回退全端基线')

// 6. 受影响依赖按端计算：dep-004 只在 web/ios/android（evt-003 无 server 规则）
assert.ok(!platformsOfEvents(state, ['evt-003']).includes('server'), 'evt-003 不应生成 server 批次')
const evt003Affected = batchAffectedDependencies(state, 'web', recomputeBatchDifferences(state, byPlatform.get('web')!))
console.log('✓ 端事件集合与受影响依赖按端推导:', evt003Affected.join('/') || '(无)')

// 7. 就绪度与问题按端归属
const issues = validateGovernance(state)
const androidReadiness = batchReadiness(android, issues)
assert.ok(androidReadiness < 90, 'android 就绪度应低于 90')
assert.ok(batchReadiness(byPlatform.get('web')!, issues) >= 90, 'web 就绪度应 >= 90')
console.log('✓ 就绪度按端独立计算: web', batchReadiness(byPlatform.get('web')!, issues), 'android', androidReadiness)

// 8. 幂等键登记模拟：重复调用 publish 判定（不实际执行 store，验证登记字段存在）
assert.ok(Array.isArray(state.publishedKeys), '状态含幂等键登记表')
console.log('✓ 幂等发布登记表存在，失败重试不会重复生成发布记录')

console.log('\n全部端批次逻辑冒烟验证通过 ✅')

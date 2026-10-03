import type {
  ContractDifference,
  EventDefinition,
  EventVersionSnapshot,
  GovernanceState,
  Platform,
  ReleaseApproval,
  ReleaseBatch,
  ReleaseCandidate,
  ValidationIssue,
} from '@/models/domain'
import { createId } from '@/services/repository'
import { compareEventContract } from '@/services/selectors'

const APPROVAL_ROLES: ReleaseApproval['role'][] = ['data', 'product', 'client', 'qa']
const APPROVAL_ACTORS: Record<ReleaseApproval['role'], string> = {
  data: '顾清',
  product: '丁禾',
  client: '江驰',
  qa: '余安',
}

/** 事件在某端是否启用采集 */
export const eventEnabledOnPlatform = (event: EventDefinition | undefined, platform: Platform): boolean =>
  Boolean(event?.platformRules.find((rule) => rule.platform === platform)?.enabled)

/** 事件参与某端批次的属性：属性声明适用该端，且该端规则启用 */
export const batchProperties = (event: EventDefinition, platform: Platform) =>
  event.properties.filter((property) => !property.deletedAt && property.platforms.includes(platform))

/**
 * 端视角基线：优先取该端最近快照；没有端快照（历史数据）时回退到当时的全端基线。
 * 历史基线没有 platform 字段，视为当时平台规则下的兼容基线。
 */
export const latestPlatformBaseline = (
  baselines: EventVersionSnapshot[],
  eventId: string,
  platform: Platform,
): EventVersionSnapshot | undefined => {
  const scoped = baselines
    .filter((baseline) => baseline.eventId === eventId && baseline.platform === platform)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0]
  if (scoped) return scoped
  return baselines
    .filter((baseline) => baseline.eventId === eventId && baseline.platform === undefined)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0]
}

/** 基于某端基线，按该端属性集重算契约差异 */
export const compareBatchEvent = (
  state: GovernanceState,
  eventId: string,
  platform: Platform,
): ContractDifference | null => {
  const event = state.events.find((item) => item.id === eventId)
  if (!event || !eventEnabledOnPlatform(event, platform)) return null
  const baseline = latestPlatformBaseline(state.baselines, eventId, platform)
  const full = compareEventContract(
    // 按端属性集合参与比较：端基线属性 ∪ 当前端属性
    { ...event, properties: batchProperties(event, platform) },
    baseline
      ? { ...baseline, properties: baseline.properties.filter((property) => property.platforms.includes(platform)) }
      : undefined,
  )
  return full
}

/** 只重算给定端批次涉及的差异；未受影响批次不重算 */
export const recomputeBatchDifferences = (
  state: GovernanceState,
  batch: ReleaseBatch,
): ContractDifference[] =>
  batch.eventIds
    .map((eventId) => compareBatchEvent(state, eventId, batch.platform))
    .filter((item): item is ContractDifference => Boolean(item))

/** 某端差异影响到的下游：依赖按属性引用，且引用属性在该端变更集合内 */
export const batchAffectedDependencies = (
  state: GovernanceState,
  platform: Platform,
  differences: ContractDifference[],
): string[] => {
  const changedByEvent = new Map<string, { ids: Set<string>; names: Set<string> }>()
  differences.forEach((difference) => {
    const entry = changedByEvent.get(difference.eventId) ?? {
      ids: new Set<string>(),
      names: new Set<string>(),
    }
    ;(difference.changedPropertyIds ?? []).forEach((id) => entry.ids.add(id))
    // 历史差异无 ID 时，用名称兜底
    ;[
      ...difference.addedProperties,
      ...difference.removedProperties,
      ...difference.requiredChanges.map((item) => item.split(':')[0] ?? ''),
      ...difference.typeChanges.map((item) => item.split(':')[0] ?? ''),
      ...difference.enumChanges.map((item) => item.split(':')[0] ?? ''),
    ].forEach((name) => {
      if (name) entry.names.add(name)
    })
    changedByEvent.set(difference.eventId, entry)
  })

  return state.dependencies
    .filter((dependency) =>
      dependency.propertyRefs.some((reference) => {
        const changed = changedByEvent.get(reference.eventId)
        if (!changed) return false
        const event = state.events.find((item) => item.id === reference.eventId)
        if (!event || !eventEnabledOnPlatform(event, platform)) return false
        const property = event.properties.find((item) => item.id === reference.propertyId)
        // 属性已删除：回到端基线按名称判断
        if (!property || property.deletedAt) {
          const baseline = latestPlatformBaseline(state.baselines, reference.eventId, platform)
          const baselineProperty = baseline?.properties.find(
            (item) => item.id === reference.propertyId,
          )
          return Boolean(baselineProperty && changed.names.has(baselineProperty.name))
        }
        // 属性不属于该端：该引用在端批次范围外，不构成影响
        if (!property.platforms.includes(platform)) return false
        return changed.ids.has(property.id) || changed.names.has(property.name)
      }),
    )
    .map((dependency) => dependency.id)
}

const freshApprovals = (): ReleaseApproval[] =>
  APPROVAL_ROLES.map((role) => ({
    id: createId('appr'),
    role,
    actor: APPROVAL_ACTORS[role],
    status: 'pending' as const,
    comment: '',
  }))

/** 为发布候选构建一个端批次（用于创建候选和历史回填） */
export const buildReleaseBatch = (
  state: GovernanceState,
  release: { id: string; version: string },
  platform: Platform,
  eventIds: string[],
  options: { backfilled?: boolean; now?: string } = {},
): ReleaseBatch | null => {
  const scopedEventIds = eventIds.filter((eventId) =>
    eventEnabledOnPlatform(state.events.find((item) => item.id === eventId), platform),
  )
  if (scopedEventIds.length === 0) return null

  const now = options.now ?? new Date().toISOString()
  const stub: ReleaseBatch = {
    id: createId('batch'),
    releaseId: release.id,
    platform,
    status: 'reviewing',
    eventIds: scopedEventIds,
    affectedDependencyIds: [],
    differences: [],
    migrationConfirmations: [],
    approvals: [],
    dirty: false,
    backfilled: Boolean(options.backfilled),
    writeState: 'idle',
    writeAttempts: 0,
    createdAt: now,
    updatedAt: now,
    revision: 1,
  }
  stub.differences = recomputeBatchDifferences(state, stub)
  stub.affectedDependencyIds = batchAffectedDependencies(state, platform, stub.differences)
  stub.migrationConfirmations = stub.affectedDependencyIds.map((dependencyId) => ({
    id: createId('mig'),
    dependencyId,
    version: release.version,
    status: 'pending' as const,
    reviewer: state.dependencies.find((dependency) => dependency.id === dependencyId)?.owner ?? '',
    note: '',
  }))
  stub.approvals = freshApprovals()
  return stub
}

/** 候选下出现的端（按候选事件启用规则推导），保证创建顺序稳定 */
export const platformsOfEvents = (state: GovernanceState, eventIds: string[]): Platform[] => {
  const result = new Set<Platform>()
  eventIds.forEach((eventId) => {
    const event = state.events.find((item) => item.id === eventId)
    event?.platformRules
      .filter((rule) => rule.enabled)
      .forEach((rule) => result.add(rule.platform))
  })
  return [...result]
}

/** 迁移与审批是否齐备（独立发布的门禁） */
export const batchGatesReady = (batch: ReleaseBatch): boolean =>
  batch.migrationConfirmations.every((item) => item.status === 'confirmed') &&
  batch.approvals.every((item) => item.status === 'approved')

/** 端批次就绪度 0-100 */
export const batchReadiness = (
  batch: ReleaseBatch,
  issues: ValidationIssue[],
): number => {
  const migrationTotal = batch.migrationConfirmations.length
  const migrationDone = batch.migrationConfirmations.filter(
    (item) => item.status === 'confirmed',
  ).length
  const approvalTotal = batch.approvals.length
  const approvalDone = batch.approvals.filter((item) => item.status === 'approved').length
  // 破坏性类型变更已由“迁移确认”门禁承接，不在就绪度重复扣分；
  // 这里只统计未被门禁覆盖的治理问题。
  const batchIssues = issues.filter(
    (issue) =>
      batch.eventIds.includes(issue.entityId) &&
      issue.kind !== 'type_change' &&
      (!issue.platforms || issue.platforms.includes(batch.platform)),
  ).length
  const issuePenalty = Math.min(40, batchIssues * 8)
  const migrationScore = migrationTotal === 0 ? 40 : (migrationDone / migrationTotal) * 40
  const approvalScore = approvalTotal === 0 ? 30 : (approvalDone / approvalTotal) * 30
  const dirtyPenalty = batch.dirty ? 10 : 0
  return Math.max(0, Math.round(migrationScore + approvalScore + 30 - issuePenalty - dirtyPenalty))
}

/** 由各端批次状态聚合候选状态 */
export const aggregateReleaseStatus = (
  release: ReleaseCandidate,
): ReleaseCandidate['status'] => {
  const batches = release.batches ?? []
  if (batches.length === 0) return release.status
  if (batches.every((batch) => batch.status === 'published')) return 'published'
  if (batches.every((batch) => batch.status === 'rolled_back')) return 'rolled_back'
  if (batches.some((batch) => batch.status === 'published')) return 'partially_published'
  if (batches.every((batch) => batch.status === 'approved')) return 'approved'
  if (batches.some((batch) => batch.status === 'reviewing' || batch.status === 'approved')) {
    return 'reviewing'
  }
  return 'draft'
}

/** 汇总候选下各端批次的字段（供既有列表视图使用） */
export const syncReleaseAggregates = (release: ReleaseCandidate): void => {
  const batches = release.batches ?? []
  release.eventIds = [...new Set(batches.flatMap((batch) => batch.eventIds))]
  release.affectedDependencyIds = [
    ...new Set(batches.flatMap((batch) => batch.affectedDependencyIds)),
  ]
  release.differences = batches.flatMap((batch) => batch.differences)
  release.migrationConfirmations = batches.flatMap((batch) => batch.migrationConfirmations)
  release.approvals = batches.flatMap((batch) => batch.approvals)
  const published = batches.filter((batch) => batch.status === 'published')
  release.status = aggregateReleaseStatus(release)
  if (published.length === batches.length && batches.length > 0) {
    release.publishedAt = published.map((batch) => batch.publishedAt ?? '').sort().slice(-1)[0]
  }
}

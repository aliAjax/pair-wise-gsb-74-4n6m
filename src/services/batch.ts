import type {
  ContractDifference,
  EventDefinition,
  EventVersionSnapshot,
  GovernanceState,
  MigrationConfirmation,
  Platform,
  PlatformBatch,
  PlatformRuleSnapshot,
  ReleaseApproval,
  ReleaseCandidate,
  ValidationIssue,
} from '@/models/domain'
import { createId } from '@/services/id'

export const PLATFORM_OPTIONS: Array<{ label: string; value: Platform }> = [
  { label: 'Web', value: 'web' },
  { label: 'iOS', value: 'ios' },
  { label: 'Android', value: 'android' },
  { label: 'Server', value: 'server' },
  { label: '小程序', value: 'miniprogram' },
]

export const platformLabel = (platform: Platform): string =>
  PLATFORM_OPTIONS.find((option) => option.value === platform)?.label ?? platform

export const APPROVAL_ACTORS: Record<ReleaseApproval['role'], string> = {
  data: '顾清',
  product: '丁禾',
  client: '江驰',
  qa: '余安',
}

const cloneApprovals = (): ReleaseApproval[] =>
  (Object.keys(APPROVAL_ACTORS) as Array<ReleaseApproval['role']>).map((role) => ({
    id: createId('appr'),
    role,
    actor: APPROVAL_ACTORS[role],
    status: 'pending',
    comment: '',
  }))

export const ruleSnapshot = (rule: {
  id: string
  platform: Platform
  enabled: boolean
  trigger: string
  owner: string
  requiredPropertyIds: string[]
  note: string
}): PlatformRuleSnapshot => ({
  ruleId: rule.id,
  platform: rule.platform,
  enabled: rule.enabled,
  trigger: rule.trigger,
  owner: rule.owner,
  requiredPropertyIds: [...rule.requiredPropertyIds],
  note: rule.note,
})

const eventSnapshot = (event: EventDefinition, platform: Platform) => {
  const rules = event.platformRules
    .filter((rule) => rule.platform === platform)
    .map(ruleSnapshot)
  return { eventId: event.id, rules }
}

/** 该端是否为事件启用采集（无规则视为未接入） */
export const platformEnabledForEvent = (event: EventDefinition, platform: Platform): boolean =>
  event.platformRules.some((rule) => rule.platform === platform && rule.enabled)

const latestBaseline = (
  baselines: EventVersionSnapshot[],
  eventId: string,
): EventVersionSnapshot | undefined =>
  baselines
    .filter((baseline) => baseline.eventId === eventId)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0]

/** 单事件单端契约差异（仅比较该端适用的属性，并附加平台规则变化） */
export const compareEventContractForPlatform = (
  event: EventDefinition,
  baseline: EventVersionSnapshot | undefined,
  platform: Platform,
  previousRules: PlatformRuleSnapshot[] = [],
): ContractDifference => {
  const currentSnapshots = event.platformRules
    .filter((rule) => rule.platform === platform)
    .map(ruleSnapshot)

  // 基线是发布当时的全端口径，按全部历史属性比较；只在当前契约侧按端过滤
  const before = baseline?.properties ?? []
  const after = event.properties.filter(
    (property) => !property.deletedAt && property.platforms.includes(platform),
  )
  const beforeMap = new Map(before.map((property) => [property.id, property]))
  const afterMap = new Map(after.map((property) => [property.id, property]))
  const addedProperties: string[] = []
  const removedProperties: string[] = []
  const requiredChanges: string[] = []
  const typeChanges: string[] = []
  const enumChanges: string[] = []

  after.forEach((property) => {
    const previous = beforeMap.get(property.id)
    if (!previous) {
      addedProperties.push(property.name)
      return
    }
    if (previous.required !== property.required) {
      requiredChanges.push(
        `${property.name}: ${previous.required ? '必填' : '选填'} → ${property.required ? '必填' : '选填'}`,
      )
    }
    if (previous.type !== property.type) {
      typeChanges.push(`${property.name}: ${previous.type} → ${property.type}`)
    }
    if (previous.enumValues.join('|') !== property.enumValues.join('|')) {
      const added = property.enumValues.filter((value) => !previous.enumValues.includes(value))
      const removed = previous.enumValues.filter((value) => !property.enumValues.includes(value))
      enumChanges.push(
        `${property.name}: ${added.length ? `新增 ${added.join('/')}` : ''}${added.length && removed.length ? '；' : ''}${removed.length ? `移除 ${removed.join('/')}` : ''}`,
      )
    }
  })
  before.forEach((property) => {
    if (!afterMap.has(property.id)) removedProperties.push(property.name)
  })

  const platformRuleChanges: string[] = []
  currentSnapshots.forEach((current) => {
    const previous =
      previousRules.find((item) => item.ruleId === current.ruleId) ??
      previousRules.find((item) => item.platform === current.platform)
    if (!previous) {
      platformRuleChanges.push(`${platform} 规则新增：${current.trigger}`)
      return
    }
    if (previous.enabled !== current.enabled) {
      platformRuleChanges.push(`${platform} 采集由${previous.enabled ? '启用' : '停用'}改为${current.enabled ? '启用' : '停用'}`)
    }
    if (previous.trigger !== current.trigger) {
      platformRuleChanges.push(`${platform} 触发时机调整`)
    }
    if (previous.requiredPropertyIds.join('|') !== current.requiredPropertyIds.join('|')) {
      platformRuleChanges.push(`${platform} 必填属性集合变化`)
    }
    if (previous.note !== current.note) {
      platformRuleChanges.push(`${platform} 差异说明更新`)
    }
  })
  previousRules.forEach((previous) => {
    if (!currentSnapshots.some((current) => current.ruleId === previous.ruleId)) {
      platformRuleChanges.push(`${platform} 规则移除：${previous.trigger}`)
    }
  })

  return {
    eventId: event.id,
    eventKey: event.key,
    addedProperties,
    removedProperties,
    requiredChanges,
    typeChanges,
    enumChanges,
    platformRuleChanges,
  }
}

/** 受属性差异影响、且该端确实适用的下游依赖 */
export const affectedDependenciesForPlatform = (
  state: GovernanceState,
  platform: Platform,
  eventIds: string[],
  differences: ContractDifference[],
): string[] => {
  const changedPropertyNames = new Set<string>()
  differences.forEach((difference) => {
    ;[
      ...difference.addedProperties,
      ...difference.removedProperties,
      ...difference.requiredChanges.map((item) => item.split(':')[0] ?? ''),
      ...difference.typeChanges.map((item) => item.split(':')[0] ?? ''),
      ...difference.enumChanges.map((item) => item.split(':')[0] ?? ''),
    ].forEach((name) => {
      if (name) changedPropertyNames.add(name)
    })
  })
  if (changedPropertyNames.size === 0) return []

  return state.dependencies
    .filter((dependency) =>
      dependency.propertyRefs.some((reference) => {
        if (!eventIds.includes(reference.eventId)) return false
        const event = state.events.find((item) => item.id === reference.eventId)
        const property = event?.properties.find((item) => item.id === reference.propertyId)
        if (!event || !property) return false
        const changed = changedPropertyNames.has(property.name)
        return changed && property.platforms.includes(platform)
      }),
    )
    .map((dependency) => dependency.id)
}

const buildMigrations = (
  state: GovernanceState,
  version: string,
  dependencyIds: string[],
): MigrationConfirmation[] =>
  dependencyIds.map((dependencyId) => ({
    id: createId('mig'),
    dependencyId,
    version,
    status: 'pending',
    reviewer: state.dependencies.find((dependency) => dependency.id === dependencyId)?.owner ?? '',
    note: '',
  }))

const computeBatchPayload = (
  state: GovernanceState,
  platform: Platform,
  eventIds: string[],
  previousByEvent?: Map<string, PlatformRuleSnapshot[]>,
): Pick<
  PlatformBatch,
  'eventIds' | 'differences' | 'ruleSnapshots' | 'affectedDependencyIds'
> => {
  const scopedEvents = eventIds
    .map((eventId) => state.events.find((event) => event.id === eventId))
    .filter((event): event is EventDefinition => Boolean(event))
    .filter((event) => platformEnabledForEvent(event, platform))

  const differences = scopedEvents.map((event) =>
    compareEventContractForPlatform(
      event,
      latestBaseline(state.baselines, event.id),
      platform,
      previousByEvent?.get(event.id) ?? [],
    ),
  )
  const affectedDependencyIds = affectedDependenciesForPlatform(
    state,
    platform,
    scopedEvents.map((event) => event.id),
    differences,
  )
  return {
    eventIds: scopedEvents.map((event) => event.id),
    differences,
    ruleSnapshots: scopedEvents.map((event) => eventSnapshot(event, platform)),
    affectedDependencyIds,
  }
}

/** 为一个新发布候选推导全部端批次（当前规则口径） */
export const deriveReleaseBatches = (
  state: GovernanceState,
  releaseId: string,
  version: string,
  eventIds: string[],
): PlatformBatch[] =>
  PLATFORM_OPTIONS.map(({ value: platform }): PlatformBatch | null => {
    const payload = computeBatchPayload(state, platform, eventIds)
    if (payload.eventIds.length === 0) return null
    return {
      id: createId('batch'),
      releaseId,
      platform,
      status: 'reviewing',
      ...payload,
      migrationConfirmations: buildMigrations(state, version, payload.affectedDependencyIds),
      approvals: cloneApprovals(),
      revision: 1,
      computedAt: new Date().toISOString(),
      history: [
        {
          id: createId('hist'),
          action: 'created',
          actor: '当前用户',
          detail: `按 ${platformLabel(platform)} 端规则生成批次，含 ${payload.eventIds.length} 个事件`,
          at: new Date().toISOString(),
        },
      ],
    }
  }).filter((batch): batch is PlatformBatch => Boolean(batch))

/** 历史发布单兼容回填：按当时平台规则重建某端批次的差异口径（规则视为基线，不报规则新增） */
export const computePlatformBatchForBackfill = (
  state: GovernanceState,
  release: Pick<ReleaseCandidate, 'eventIds' | 'version'>,
  platform: Platform,
): Pick<PlatformBatch, 'eventIds' | 'differences' | 'ruleSnapshots' | 'affectedDependencyIds'> => {
  const payload = computeBatchPayload(state, platform, release.eventIds)
  // 回填批次以当前规则快照为基线，清掉“规则新增”噪音：当时这些规则本就存在
  const differences = payload.differences.map((difference) => ({
    ...difference,
    platformRuleChanges: [],
  }))
  return { ...payload, differences }
}

/** 端批次是否终态：终态批次不再被规则变更重算 */
export const isBatchTerminal = (batch: PlatformBatch): boolean =>
  batch.status === 'published' || batch.status === 'rolled_back'

export interface RecomputeResult {
  batch: PlatformBatch
  changed: boolean
  affectedPlatforms: Platform[]
}

const signatureOf = (batch: PlatformBatch): string =>
  JSON.stringify({
    eventIds: batch.eventIds,
    affected: batch.affectedDependencyIds,
    diffs: batch.differences.map((difference) => ({
      eventId: difference.eventId,
      added: difference.addedProperties,
      removed: difference.removedProperties,
      required: difference.requiredChanges,
      type: difference.typeChanges,
      enum: difference.enumChanges,
      rules: difference.platformRuleChanges ?? [],
    })),
  })

/**
 * 事件或平台规则一改，只重算受影响端的非终态批次。
 * 迁移清单按新口径增删；若确有实质变化，四角色审批需重新会签。
 */
export const recomputeBatch = (
  state: GovernanceState,
  batch: PlatformBatch,
  releaseVersion: string,
): RecomputeResult => {
  if (isBatchTerminal(batch)) return { batch, changed: false, affectedPlatforms: [] }

  const previousByEvent = new Map(
    batch.ruleSnapshots.map((item) => [item.eventId, item.rules]),
  )
  const beforeSignature = signatureOf(batch)
  const candidateEventIds = Array.from(
    new Set([...batch.eventIds, ...batch.ruleSnapshots.map((item) => item.eventId)]),
  )
  const payload = computeBatchPayload(
    state,
    batch.platform,
    candidateEventIds,
    previousByEvent,
  )

  const next: PlatformBatch = structuredClone(batch)
  next.eventIds = payload.eventIds
  next.differences = payload.differences
  next.ruleSnapshots = payload.ruleSnapshots
  next.computedAt = new Date().toISOString()

  const migrationMap = new Map(
    next.migrationConfirmations.map((confirmation) => [confirmation.dependencyId, confirmation]),
  )
  next.affectedDependencyIds = payload.affectedDependencyIds
  next.migrationConfirmations = payload.affectedDependencyIds.map((dependencyId) => {
    const existing = migrationMap.get(dependencyId)
    if (existing) return existing
    return buildMigrations(state, releaseVersion, [dependencyId])[0]!
  })

  const changed = signatureOf(next) !== beforeSignature
  if (changed) {
    next.revision += 1
    // 实质变化后会签作废，需重新审批；审批人保留便于再次确认
    next.approvals = next.approvals.map((approval) =>
      approval.status === 'approved'
        ? { ...approval, status: 'pending', comment: `${approval.comment}（规则变更后需重审）`.trim() }
        : approval,
    )
    next.history.unshift({
      id: createId('hist'),
      action: 'recomputed',
      actor: '系统',
      detail: `${platformLabel(batch.platform)} 端受事件或规则变更影响，已按最新口径重算并重置会签`,
      at: new Date().toISOString(),
    })
  }
  return { batch: next, changed, affectedPlatforms: changed ? [batch.platform] : [] }
}

/** 规则变更后受影响的端 */
export const platformsAffectedByRule = (
  state: GovernanceState,
  eventId: string,
  platform?: Platform,
): Platform[] => {
  const event = state.events.find((item) => item.id === eventId)
  if (!event) return []
  if (platform) return [platform]
  return Array.from(new Set(event.platformRules.map((rule) => rule.platform)))
}

/** 事件变更（属性等）影响到它接入的全部端 */
export const platformsOfEvent = (state: GovernanceState, eventId: string): Platform[] => {
  const event = state.events.find((item) => item.id === eventId)
  if (!event) return []
  return Array.from(new Set(event.platformRules.filter((rule) => rule.enabled).map((rule) => rule.platform)))
}

/** 端批次门禁：迁移全部确认、四角色全部通过、无未解决的严重阻断问题 */
export const batchMigrationsReady = (batch: PlatformBatch): boolean =>
  batch.migrationConfirmations.every((item) => item.status === 'confirmed')

export const batchApprovalsReady = (batch: PlatformBatch): boolean =>
  batch.approvals.every((item) => item.status === 'approved')

/**
 * 就绪度：迁移 40 + 审批 30 + 基础 30，按该端未解决的校验问题扣分。
 * 类型变化等是本次发布内容本身，其迁移确认完成后不再阻断；只有严重问题（如仍引用已删除字段）硬扣分。
 */
export const batchReadiness = (batch: PlatformBatch, issues: ValidationIssue[]): number => {
  const migrationTotal = batch.migrationConfirmations.length
  const migrationDone = batch.migrationConfirmations.filter(
    (item) => item.status === 'confirmed',
  ).length
  const approvalTotal = batch.approvals.length
  const approvalDone = batch.approvals.filter((item) => item.status === 'approved').length
  const blockingIssues = issues.filter(
    (issue) =>
      batch.eventIds.includes(issue.entityId) ||
      batch.affectedDependencyIds.includes(issue.entityId),
  )
  const confirmedDependencyIds = new Set(
    batch.migrationConfirmations
      .filter((item) => item.status === 'confirmed')
      .map((item) => item.dependencyId),
  )
  const issuePenalty = blockingIssues.reduce((penalty, issue) => {
    // 下游引用问题随迁移确认解除
    if (confirmedDependencyIds.has(issue.entityId)) return penalty
    if (issue.severity === 'critical') return penalty + 20
    if (issue.severity === 'high') return penalty + 4
    return penalty + 2
  }, 0)
  const migrationScore = migrationTotal === 0 ? 40 : (migrationDone / migrationTotal) * 40
  const approvalScore = approvalTotal === 0 ? 30 : (approvalDone / approvalTotal) * 30
  return Math.max(0, Math.round(migrationScore + approvalScore + 30 - Math.min(40, issuePenalty)))
}

export const canPublishBatch = (
  batch: PlatformBatch,
  issues: ValidationIssue[],
): { ok: boolean; reason?: string } => {
  if (batch.status === 'published') return { ok: false, reason: '该端批次已发布' }
  if (batch.status === 'rolled_back') return { ok: false, reason: '该端批次已回滚' }
  if (!batchMigrationsReady(batch)) return { ok: false, reason: '该端仍有下游迁移未确认' }
  if (!batchApprovalsReady(batch)) return { ok: false, reason: '该端四角色审批尚未全部通过' }
  if (batchReadiness(batch, issues) < 90) return { ok: false, reason: '该端发布就绪度未达门禁（90%）' }
  return { ok: true }
}

export const findBatch = (
  state: GovernanceState,
  batchId: string,
): { release: ReleaseCandidate; batch: PlatformBatch } | null => {
  for (const release of state.releases) {
    const batch = release.batches.find((item) => item.id === batchId)
    if (batch) return { release, batch }
  }
  return null
}

/** 发布候选整体状态随端批次聚合 */
export const aggregateReleaseStatus = (release: ReleaseCandidate): ReleaseCandidate['status'] => {
  if (release.batches.length === 0) return release.status
  if (release.batches.every((batch) => batch.status === 'published')) return 'published'
  if (release.batches.some((batch) => batch.status === 'published')) return 'reviewing'
  if (release.batches.every((batch) => batch.status === 'rolled_back')) return 'rolled_back'
  return 'reviewing'
}

export const releasePublishedAt = (release: ReleaseCandidate): string | undefined => {
  const published = release.batches
    .filter((batch) => batch.publishedAt)
    .map((batch) => batch.publishedAt!)
    .sort()
  return published[published.length - 1]
}

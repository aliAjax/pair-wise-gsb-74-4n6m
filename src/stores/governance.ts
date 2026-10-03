import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type {
  DeprecationPlan,
  EventDefinition,
  EventProperty,
  GovernanceState,
  Platform,
  PlatformBatch,
  PlatformRule,
  PublicationRecord,
  ReleaseApproval,
  ReleaseCandidate,
  RollbackRecord,
} from '@/models/domain'
import { createId, loadState, resetState, saveState, subscribeState } from '@/services/repository'
import {
  aggregateReleaseStatus,
  canPublishBatch,
  deriveReleaseBatches,
  findBatch,
  isBatchTerminal,
  platformsAffectedByRule,
  platformsOfEvent,
  recomputeBatch,
  releasePublishedAt,
} from '@/services/batch'
import { invalidateGovernanceQueries } from '@/services/queryClient'
import { validateGovernance } from '@/services/selectors'

export type BatchActionOutcome =
  | { ok: true; batch: PlatformBatch }
  | { ok: false; reason: 'conflict' | 'gate' | 'not_found' | 'write_failed'; batch?: PlatformBatch; detail?: string }

export interface BatchScope {
  releaseId: string
  platform: Platform | ''
}

const addHistory = (
  batch: PlatformBatch,
  action: PlatformBatch['history'][number]['action'],
  detail: string,
  actor = '当前用户',
): void => {
  batch.history.unshift({ id: createId('hist'), action, actor, detail, at: new Date().toISOString() })
}

export const useGovernanceStore = defineStore('governance', () => {
  const data = ref<GovernanceState>(loadState())
  const lastSavedAt = ref(new Date().toISOString())
  /** 其它窗口先写入后，当前窗口保留的冲突提示（端批次 id → 对方 revision） */
  const externalUpdate = ref<{ batchId: string; theirRevision: number; at: string } | null>(null)
  const scope = ref<BatchScope>({
    releaseId:
      data.value.releases.find((release) => release.status === 'reviewing')?.id ??
      data.value.releases[0]?.id ??
      '',
    platform: '',
  })

  const issues = computed(() => validateGovernance(data.value))

  const persist = (): void => {
    saveState(data.value)
    lastSavedAt.value = new Date().toISOString()
  }

  // 跨窗口：其它标签页写入后同步当前窗口数据并失效查询缓存
  if (typeof window !== 'undefined') {
    subscribeState((incoming) => {
      const previousBatches = new Map(
        data.value.releases.flatMap((release) =>
          release.batches.map((batch) => [batch.id, batch.revision] as const),
        ),
      )
      data.value = incoming
      incoming.releases.forEach((release) => {
        release.batches.forEach((batch) => {
          const myRevision = previousBatches.get(batch.id)
          if (myRevision !== undefined && myRevision !== batch.revision) {
            externalUpdate.value = {
              batchId: batch.id,
              theirRevision: batch.revision,
              at: new Date().toISOString(),
            }
          }
        })
      })
      lastSavedAt.value = new Date().toISOString()
      void invalidateGovernanceQueries()
    })
  }

  const audit = (
    entityType: string,
    entityId: string,
    action: string,
    detail: string,
  ): void => {
    data.value.audit.unshift({
      id: createId('aud'),
      entityType,
      entityId,
      action,
      actor: '当前用户',
      detail,
      createdAt: new Date().toISOString(),
    })
  }

  /**
   * 事件或平台规则改动后，只重算受影响端的非终态批次。
   * @param platforms 受影响的端；为空表示该事件接入的全部端
   */
  const recomputeAffectedBatches = (
    eventId: string,
    platforms?: Platform[],
    changeSummary = '契约内容变化',
  ): Platform[] => {
    const affected = platforms && platforms.length > 0 ? platforms : platformsOfEvent(data.value, eventId)
    const affectedSet = new Set(affected)
    const changedPlatforms = new Set<Platform>()

    data.value.releases.forEach((release) => {
      release.batches.forEach((batch, index) => {
        if (!affectedSet.has(batch.platform) || isBatchTerminal(batch)) return
        if (
          !batch.eventIds.includes(eventId) &&
          !batch.ruleSnapshots.some((item) => item.eventId === eventId)
        ) {
          return
        }
        const result = recomputeBatch(data.value, batch, release.version)
        if (result.changed) {
          release.batches[index] = result.batch
          changedPlatforms.add(batch.platform)
        }
      })
      release.status = aggregateReleaseStatus(release)
    })

    if (changedPlatforms.size > 0) {
      const event = data.value.events.find((item) => item.id === eventId)
      audit(
        'event',
        eventId,
        '重算受影响端批次',
        `${event?.key ?? eventId} ${changeSummary}，仅重算 ${[...changedPlatforms].join('、')} 端`,
      )
    }
    return [...changedPlatforms]
  }

  const saveEvent = (event: EventDefinition): void => {
    const index = data.value.events.findIndex((item) => item.id === event.id)
    const isNew = index < 0
    const saved = { ...event, updatedAt: new Date().toISOString() }
    if (index >= 0) {
      data.value.events[index] = saved
    } else {
      data.value.events.unshift(saved)
    }
    if (!isNew) recomputeAffectedBatches(event.id, undefined, '事件契约内容变化')
    audit('event', event.id, isNew ? '创建事件' : '更新事件', `${event.key} 契约已保存`)
    persist()
  }

  const saveProperty = (eventId: string, property: EventProperty): void => {
    const event = data.value.events.find((item) => item.id === eventId)
    if (!event) return
    const index = event.properties.findIndex((item) => item.id === property.id)
    const isNew = index < 0
    if (index >= 0) {
      event.properties[index] = property
    } else {
      event.properties.push(property)
    }
    event.updatedAt = new Date().toISOString()
    // 属性平台范围变化只重算其适用端
    if (!isNew) recomputeAffectedBatches(eventId, property.platforms, `属性 ${property.name} 变化`)
    audit('property', property.id, isNew ? '新增属性' : '更新属性', `${event.key}.${property.name}`)
    persist()
  }

  const deleteProperty = (eventId: string, propertyId: string): void => {
    const event = data.value.events.find((item) => item.id === eventId)
    const property = event?.properties.find((item) => item.id === propertyId)
    if (!event || !property) return
    property.deletedAt = new Date().toISOString()
    event.updatedAt = new Date().toISOString()
    recomputeAffectedBatches(eventId, property.platforms, `删除属性 ${property.name}`)
    audit('property', propertyId, '标记删除', `${event.key}.${property.name} 进入删除兼容期`)
    persist()
  }

  const savePlatformRule = (eventId: string, rule: PlatformRule): void => {
    const event = data.value.events.find((item) => item.id === eventId)
    if (!event) return
    const index = event.platformRules.findIndex((item) => item.id === rule.id)
    const isNew = index < 0
    if (index >= 0) {
      event.platformRules[index] = rule
    } else {
      event.platformRules.push(rule)
    }
    event.updatedAt = new Date().toISOString()
    // 某端平台规则一改，只重算该端
    recomputeAffectedBatches(
      eventId,
      platformsAffectedByRule(data.value, eventId, rule.platform),
      `${rule.platform} 端平台规则变化`,
    )
    audit(
      'platform_rule',
      rule.id,
      isNew ? '新增平台规则' : '更新平台规则',
      `${event.key}/${rule.platform}`,
    )
    persist()
  }

  const createRelease = (version: string, title: string, eventIds: string[]): ReleaseCandidate => {
    const releaseId = createId('rel')
    const batches = deriveReleaseBatches(data.value, releaseId, version, eventIds)
    const affectedDependencyIds = Array.from(
      new Set(batches.flatMap((batch) => batch.affectedDependencyIds)),
    )
    const release: ReleaseCandidate = {
      id: releaseId,
      version,
      title,
      status: 'reviewing',
      eventIds,
      affectedDependencyIds,
      differences: batches.flatMap((batch) => batch.differences),
      migrationConfirmations: batches.flatMap((batch) => batch.migrationConfirmations),
      approvals: batches[0]?.approvals ?? [],
      batches,
      createdAt: new Date().toISOString(),
    }
    data.value.releases.unshift(release)
    data.value.currentVersion = version
    scope.value = { releaseId, platform: '' }
    audit(
      'release',
      release.id,
      '创建发布候选',
      `${version} 包含 ${eventIds.length} 个事件，按端拆分为 ${batches.length} 个端批次，影响 ${affectedDependencyIds.length} 个下游依赖`,
    )
    persist()
    return release
  }

  /** 乐观锁守卫：revision 不一致说明其它窗口已先提交 */
  const guardRevision = (
    batchId: string,
    expectedRevision: number,
  ):
    | { ok: true; release: ReleaseCandidate; batch: PlatformBatch }
    | { ok: false; outcome: BatchActionOutcome } => {
    const located = findBatch(data.value, batchId)
    if (!located) return { ok: false, outcome: { ok: false, reason: 'not_found' } }
    if (located.batch.revision !== expectedRevision) {
      externalUpdate.value = {
        batchId,
        theirRevision: located.batch.revision,
        at: new Date().toISOString(),
      }
      return {
        ok: false,
        outcome: { ok: false, reason: 'conflict', batch: located.batch, detail: '其它窗口已先提交该端批次' },
      }
    }
    return { ok: true, release: located.release, batch: located.batch }
  }

  const confirmBatchMigration = (
    batchId: string,
    confirmationId: string,
    reviewer: string,
    note: string,
    expectedRevision: number,
  ): BatchActionOutcome => {
    const guarded = guardRevision(batchId, expectedRevision)
    if (!guarded.ok) return guarded.outcome
    const { release, batch } = guarded
    const confirmation = batch.migrationConfirmations.find((item) => item.id === confirmationId)
    if (!confirmation) return { ok: false, reason: 'not_found' }
    confirmation.status = 'confirmed'
    confirmation.reviewer = reviewer
    confirmation.note = note
    confirmation.confirmedAt = new Date().toISOString()
    batch.revision += 1
    const dependency = data.value.dependencies.find(
      (item) => item.id === confirmation.dependencyId,
    )
    if (dependency) dependency.status = 'migrated'
    addHistory(batch, 'migration_confirmed', `${reviewer} 确认迁移：${note}`)
    audit(
      'release_batch',
      batchId,
      '确认端迁移',
      `${release.version}/${batch.platform}：${reviewer}：${note}`,
    )
    persist()
    return { ok: true, batch }
  }

  const updateBatchApproval = (
    batchId: string,
    role: ReleaseApproval['role'],
    status: ReleaseApproval['status'],
    actor: string,
    comment: string,
    expectedRevision: number,
  ): BatchActionOutcome => {
    const guarded = guardRevision(batchId, expectedRevision)
    if (!guarded.ok) return guarded.outcome
    const { release, batch } = guarded
    const approval = batch.approvals.find((item) => item.role === role)
    if (!approval) return { ok: false, reason: 'not_found' }
    approval.status = status
    approval.actor = actor
    approval.comment = comment
    approval.createdAt = new Date().toISOString()
    batch.revision += 1
    addHistory(
      batch,
      'approval_updated',
      `${role} ${status === 'approved' ? '通过' : '驳回'}：${comment}`,
    )
    audit(
      'release_batch',
      batchId,
      status === 'approved' ? '端审批通过' : '端审批驳回',
      `${release.version}/${batch.platform} ${role}：${comment}`,
    )
    persist()
    return { ok: true, batch }
  }

  /** 后到窗口保留草稿：只写草稿备注，不推进门禁 */
  const saveBatchDraft = (
    batchId: string,
    draftNote: string,
    expectedRevision: number,
  ): BatchActionOutcome => {
    const guarded = guardRevision(batchId, expectedRevision)
    if (!guarded.ok) return guarded.outcome
    const { batch } = guarded
    batch.draftNote = draftNote
    batch.revision += 1
    addHistory(batch, 'draft_saved', `保留草稿：${draftNote || '（空草稿）'}`)
    persist()
    return { ok: true, batch }
  }

  /**
   * 发布单个端批次：
   * - 门禁：该端迁移全确认 + 四角色全通过 + 就绪度 ≥ 90
   * - 幂等：同一 attemptId 直接复用已有发布台账，重试绝不重复生成
   * - 写入失败：批次置 publish_failed 并保留 attemptId，从未完成批次重试
   */
  const publishBatch = (batchId: string, attemptId: string): BatchActionOutcome => {
    const located = findBatch(data.value, batchId)
    if (!located) return { ok: false, reason: 'not_found' }
    const { release, batch } = located

    // 幂等：该 attemptId 已成功落账，直接视为成功，不重复生成发布记录
    const existingRecord = data.value.publications.find(
      (record) => record.attemptId === attemptId && record.batchId === batchId,
    )
    if (existingRecord) {
      return { ok: true, batch }
    }
    if (batch.status === 'published') {
      return { ok: false, reason: 'gate', batch, detail: '该端批次已发布' }
    }
    if (batch.status === 'rolled_back') {
      return { ok: false, reason: 'gate', batch, detail: '该端批次已回滚' }
    }

    const gate = canPublishBatch(batch, issues.value)
    if (!gate.ok) {
      return { ok: false, reason: 'gate', batch, detail: gate.reason }
    }

    // 模拟写入失败（演示用）：批次留在未完成态，保留 attemptId 供重试
    if (data.value.simulateNextPublishFailure) {
      data.value.simulateNextPublishFailure = false
      batch.status = 'publish_failed'
      batch.lastError = '契约写入失败（模拟）：发布台账未落盘，请从未完成批次重试'
      batch.lastAttemptId = attemptId
      addHistory(batch, 'publish_failed', batch.lastError)
      audit('release_batch', batchId, '端发布写入失败', `${release.version}/${batch.platform}：${batch.lastError}`)
      persist()
      return { ok: false, reason: 'write_failed', batch, detail: batch.lastError }
    }

    batch.status = 'published'
    batch.publishedAt = new Date().toISOString()
    batch.lastError = undefined
    batch.lastAttemptId = attemptId
    batch.revision += 1

    const record: PublicationRecord = {
      id: createId('pub'),
      releaseId: release.id,
      batchId,
      version: release.version,
      platform: batch.platform,
      attemptId,
      eventIds: [...batch.eventIds],
      operator: '当前用户',
      publishedAt: batch.publishedAt,
    }
    data.value.publications.unshift(record)

    // 仅发布该端涉及的事件与基线快照，不影响其它端
    batch.eventIds.forEach((eventId) => {
      const event = data.value.events.find((item) => item.id === eventId)
      if (!event) return
      event.status = 'published'
      const properties = structuredClone(
        event.properties.filter(
          (property) => !property.deletedAt && property.platforms.includes(batch.platform),
        ),
      )
      const sameVersion = data.value.baselines.find(
        (baseline) => baseline.eventId === eventId && baseline.version === event.version,
      )
      if (sameVersion) {
        sameVersion.platform = sameVersion.platform ?? batch.platform
      } else {
        data.value.baselines.unshift({
          id: createId('base'),
          eventId,
          version: event.version,
          properties,
          createdAt: batch.publishedAt!,
          status: 'published',
          platform: batch.platform,
        })
      }
    })

    addHistory(batch, 'published', `${release.version} 已按 ${batch.platform} 端发布（attempt ${attemptId}）`)
    release.status = aggregateReleaseStatus(release)
    release.publishedAt = releasePublishedAt(release)
    audit(
      'release_batch',
      batchId,
      '发布端批次',
      `${release.version}/${batch.platform} 已单独发布，含 ${batch.eventIds.length} 个事件`,
    )
    persist()
    return { ok: true, batch }
  }

  const setSimulateNextPublishFailure = (value: boolean): void => {
    data.value.simulateNextPublishFailure = value
    persist()
  }

  const saveDeprecation = (plan: DeprecationPlan): void => {
    const index = data.value.deprecations.findIndex((item) => item.id === plan.id)
    if (index >= 0) {
      data.value.deprecations[index] = plan
    } else {
      data.value.deprecations.unshift(plan)
    }
    const event = data.value.events.find((item) => item.id === plan.eventId)
    if (event && plan.status === 'stopped') event.status = 'deprecated'
    if (event && plan.status === 'retired') event.status = 'retired'
    audit('deprecation', plan.id, '更新废弃计划', `${event?.key ?? plan.eventId}：${plan.status}`)
    persist()
  }

  /** 按端回滚：只回滚单个端批次，不牵连其它已发布端 */
  const executeRollback = (
    releaseId: string,
    reason: string,
    scope: string,
    evidence: string,
    batchId?: string,
  ): void => {
    const release = data.value.releases.find((item) => item.id === releaseId)
    if (!release) return
    const batch = release.batches.find((item) => item.id === batchId)
    const record: RollbackRecord = {
      id: createId('rollback'),
      releaseId,
      batchId: batch?.id,
      platform: batch?.platform,
      version: release.version,
      reason,
      operator: '当前用户',
      scope,
      createdAt: new Date().toISOString(),
      status: 'executed',
      evidence,
    }
    data.value.rollbacks.unshift(record)
    if (batch) {
      batch.status = 'rolled_back'
      batch.revision += 1
      addHistory(batch, 'rolled_back', `按端回滚：${reason}`)
      release.status = aggregateReleaseStatus(release)
      audit(
        'rollback',
        record.id,
        '回滚端批次',
        `${release.version}/${batch.platform}：${reason}（其它端发布不受影响）`,
      )
    } else {
      release.status = 'rolled_back'
      audit('rollback', record.id, '执行回滚', `${release.version}：${reason}`)
    }
    persist()
  }

  const verifyRollback = (rollbackId: string, evidence: string): void => {
    const record = data.value.rollbacks.find((item) => item.id === rollbackId)
    if (!record) return
    record.status = 'verified'
    record.evidence = evidence
    audit('rollback', record.id, '验证回滚', evidence)
    persist()
  }

  const resetDemo = (): void => {
    data.value = resetState()
    externalUpdate.value = null
    scope.value = {
      releaseId:
        data.value.releases.find((release) => release.status === 'reviewing')?.id ??
        data.value.releases[0]?.id ??
        '',
      platform: '',
    }
    lastSavedAt.value = new Date().toISOString()
  }

  const clearExternalUpdate = (): void => {
    externalUpdate.value = null
  }

  const setScope = (next: BatchScope): void => {
    scope.value = next
  }

  const exportContract = (eventIds?: string[], platform?: Platform): string => {
    const selectedEvents = eventIds
      ? data.value.events.filter((event) => eventIds.includes(event.id))
      : data.value.events
    return JSON.stringify(
      {
        version: data.value.currentVersion,
        platform: platform ?? 'all',
        generatedAt: new Date().toISOString(),
        events: selectedEvents.map((event) => ({
          key: event.key,
          displayName: event.displayName,
          version: event.version,
          trigger: event.trigger,
          platforms: event.platformRules
            .filter((rule) => !platform || rule.platform === platform)
            .map((rule) => ({
              platform: rule.platform,
              enabled: rule.enabled,
              trigger: rule.trigger,
            })),
          properties: event.properties
            .filter(
              (property) =>
                !property.deletedAt && (!platform || property.platforms.includes(platform)),
            )
            .map(({ name, type, required, enumValues, description }) => ({
              name,
              type,
              required,
              enumValues,
              description,
            })),
        })),
      },
      null,
      2,
    )
  }

  return {
    data,
    lastSavedAt,
    issues,
    scope,
    externalUpdate,
    saveEvent,
    saveProperty,
    deleteProperty,
    savePlatformRule,
    createRelease,
    recomputeAffectedBatches,
    confirmBatchMigration,
    updateBatchApproval,
    saveBatchDraft,
    publishBatch,
    setSimulateNextPublishFailure,
    executeRollback,
    verifyRollback,
    saveDeprecation,
    resetDemo,
    exportContract,
    setScope,
    clearExternalUpdate,
  }
})

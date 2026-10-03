import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type {
  DeprecationPlan,
  EventDefinition,
  EventProperty,
  GovernanceState,
  Platform,
  PlatformRule,
  ReleaseApproval,
  ReleaseBatch,
  ReleaseCandidate,
  RollbackRecord,
} from '@/models/domain'
import { createId, loadState, resetState, saveState } from '@/services/repository'
import {
  batchAffectedDependencies,
  batchGatesReady,
  batchReadiness,
  buildReleaseBatch,
  platformsOfEvents,
  recomputeBatchDifferences,
  syncReleaseAggregates,
} from '@/services/batches'
import { validateGovernance } from '@/services/selectors'

/** 提交结果：后到方保留草稿并看到冲突 */
export interface BatchSubmitResult {
  status: 'submitted' | 'conflict'
  conflictWith?: string
}

/** 发布写入结果：写入失败时保留未完成批次，允许幂等重试 */
export interface BatchPublishResult {
  status: 'published' | 'blocked' | 'failed'
  reason?: string
}

const CLIENT_KEY = `client-${Math.random().toString(36).slice(2, 10)}`
let faultNextWrite = false

export const useGovernanceStore = defineStore('governance', () => {
  const data = ref<GovernanceState>(loadState())
  const lastSavedAt = ref(new Date().toISOString())
  /** 最近一次外部窗口写入冲突提示（storage 事件触发） */
  const externalWriteNotice = ref<string | null>(null)

  const issues = computed(() => validateGovernance(data.value))

  const persist = (): void => {
    saveState(data.value)
    lastSavedAt.value = new Date().toISOString()
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

  const findBatch = (releaseId: string, batchId: string): ReleaseBatch | undefined =>
    data.value.releases.find((release) => release.id === releaseId)?.batches?.find(
      (batch) => batch.id === batchId,
    )

  /**
   * 事件或平台规则变更：只把受影响的未发布端批次置脏。
   * - 属性变更：按属性适用端标记；
   * - 平台规则变更：只标记该端；
   * - 已发布批次是不可变历史，不置脏。
   */
  const markBatchesDirtyForEvent = (eventId: string, platforms?: Platform[]): void => {
    data.value.releases.forEach((release) => {
      release.batches?.forEach((batch) => {
        if (batch.status === 'published' || batch.status === 'rolled_back') return
        if (!batch.eventIds.includes(eventId)) return
        if (!platforms || platforms.includes(batch.platform)) {
          batch.dirty = true
          batch.updatedAt = new Date().toISOString()
        }
      })
    })
  }

  /** 按需重算单个受影响批次；迁移/审批记录保留，仅刷新差异与受影响依赖 */
  const recomputeBatch = (releaseId: string, batchId: string): ReleaseBatch | undefined => {
    const batch = findBatch(releaseId, batchId)
    if (!batch || batch.status === 'published') return batch
    batch.differences = recomputeBatchDifferences(data.value, batch)
    const nextAffected = batchAffectedDependencies(
      data.value,
      batch.platform,
      batch.differences,
    )
    // 新增受影响依赖补迁移单；已不存在的依赖保留历史确认但移出有效集合
    nextAffected.forEach((dependencyId) => {
      if (!batch.migrationConfirmations.some((item) => item.dependencyId === dependencyId)) {
        batch.migrationConfirmations.push({
          id: createId('mig'),
          dependencyId,
          version: data.value.releases.find((release) => release.id === releaseId)?.version ?? '',
          status: 'pending',
          reviewer:
            data.value.dependencies.find((dependency) => dependency.id === dependencyId)?.owner ??
            '',
          note: '',
        })
      }
    })
    batch.affectedDependencyIds = nextAffected
    batch.dirty = false
    batch.updatedAt = new Date().toISOString()
    const release = data.value.releases.find((item) => item.id === releaseId)
    if (release) syncReleaseAggregates(release)
    audit('release_batch', batch.id, '重算端批次', `${batch.platform} 端差异已按最新契约重算`)
    persist()
    return batch
  }

  const saveEvent = (event: EventDefinition): void => {
    const index = data.value.events.findIndex((item) => item.id === event.id)
    const saved = { ...event, updatedAt: new Date().toISOString() }
    if (index >= 0) {
      data.value.events[index] = saved
    } else {
      data.value.events.unshift(saved)
    }
    if (index >= 0) markBatchesDirtyForEvent(event.id)
    audit('event', event.id, index >= 0 ? '更新事件' : '创建事件', `${event.key} 契约已保存`)
    persist()
  }

  const saveProperty = (eventId: string, property: EventProperty): void => {
    const event = data.value.events.find((item) => item.id === eventId)
    if (!event) return
    const index = event.properties.findIndex((item) => item.id === property.id)
    if (index >= 0) {
      event.properties[index] = property
    } else {
      event.properties.push(property)
    }
    event.updatedAt = new Date().toISOString()
    markBatchesDirtyForEvent(eventId, property.platforms.length ? property.platforms : undefined)
    audit(
      'property',
      property.id,
      index >= 0 ? '更新属性' : '新增属性',
      `${event.key}.${property.name}`,
    )
    persist()
  }

  const deleteProperty = (eventId: string, propertyId: string): void => {
    const event = data.value.events.find((item) => item.id === eventId)
    const property = event?.properties.find((item) => item.id === propertyId)
    if (!event || !property) return
    property.deletedAt = new Date().toISOString()
    event.updatedAt = new Date().toISOString()
    markBatchesDirtyForEvent(eventId, property.platforms.length ? property.platforms : undefined)
    audit('property', property.id, '标记删除', `${event.key}.${property.name} 进入删除兼容期`)
    persist()
  }

  const savePlatformRule = (eventId: string, rule: PlatformRule): void => {
    const event = data.value.events.find((item) => item.id === eventId)
    if (!event) return
    const index = event.platformRules.findIndex((item) => item.id === rule.id)
    if (index >= 0) {
      event.platformRules[index] = rule
    } else {
      event.platformRules.push(rule)
    }
    event.updatedAt = new Date().toISOString()
    // 平台规则一改，只重算该端
    markBatchesDirtyForEvent(eventId, [rule.platform])
    audit(
      'platform_rule',
      rule.id,
      index >= 0 ? '更新平台规则' : '新增平台规则',
      `${event.key}/${rule.platform}`,
    )
    persist()
  }

  /** 创建发布候选：按端生成批次；只有该端启用的事件才进入该端批次 */
  const createRelease = (version: string, title: string, eventIds: string[]): ReleaseCandidate => {
    const release: ReleaseCandidate = {
      id: createId('rel'),
      version,
      title,
      status: 'reviewing',
      eventIds,
      affectedDependencyIds: [],
      differences: [],
      migrationConfirmations: [],
      approvals: [],
      batches: [],
      createdAt: new Date().toISOString(),
    }
    const platforms = platformsOfEvents(data.value, eventIds)
    release.batches = platforms
      .map((platform) => buildReleaseBatch(data.value, release, platform, eventIds))
      .filter((batch): batch is ReleaseBatch => Boolean(batch))
    syncReleaseAggregates(release)
    data.value.releases.unshift(release)
    data.value.currentVersion = version
    audit(
      'release',
      release.id,
      '创建发布候选',
      `${version} 按 ${platforms.length} 个端创建批次，共 ${eventIds.length} 个事件`,
    )
    persist()
    return release
  }

  const confirmMigration = (
    releaseId: string,
    batchId: string,
    confirmationId: string,
    reviewer: string,
    note: string,
  ): void => {
    const batch = findBatch(releaseId, batchId)
    const confirmation = batch?.migrationConfirmations.find((item) => item.id === confirmationId)
    if (!batch || !confirmation) return
    confirmation.status = 'confirmed'
    confirmation.reviewer = reviewer
    confirmation.note = note
    confirmation.confirmedAt = new Date().toISOString()
    const dependency = data.value.dependencies.find((item) => item.id === confirmation.dependencyId)
    if (dependency && batch.migrationConfirmations.every((item) => item.status === 'confirmed')) {
      dependency.status = 'migrated'
    }
    if (batchGatesReady(batch)) batch.status = 'approved'
    const release = data.value.releases.find((item) => item.id === releaseId)
    if (release) syncReleaseAggregates(release)
    audit(
      'release_batch',
      batch.id,
      '确认端迁移',
      `${batch.platform}：${reviewer}：${note}`,
    )
    persist()
  }

  const updateApproval = (
    releaseId: string,
    batchId: string,
    role: ReleaseApproval['role'],
    status: ReleaseApproval['status'],
    actor: string,
    comment: string,
  ): void => {
    const batch = findBatch(releaseId, batchId)
    const approval = batch?.approvals.find((item) => item.role === role)
    if (!batch || !approval) return
    approval.status = status
    approval.actor = actor
    approval.comment = comment
    approval.createdAt = new Date().toISOString()
    if (status === 'rejected') batch.status = 'reviewing'
    if (batchGatesReady(batch)) batch.status = 'approved'
    const release = data.value.releases.find((item) => item.id === releaseId)
    if (release) syncReleaseAggregates(release)
    audit('release_batch', batch.id, status === 'approved' ? '审批通过' : '审批驳回', `${batch.platform}/${role}：${comment}`)
    persist()
  }

  /**
   * 两个窗口同时提交同一端批次：后到方基于 revision 检测到冲突，
   * 其内容保留为草稿（draftConflict），批次保持先到方状态，并返回冲突。
   */
  const submitBatchDraft = (
    releaseId: string,
    batchId: string,
    draftEventIds: string[],
    expectedRevision: number,
  ): BatchSubmitResult => {
    const batch = findBatch(releaseId, batchId)
    if (!batch) return { status: 'conflict' }
    if (batch.status === 'published') {
      return { status: 'conflict', conflictWith: '批次已发布，不可再提交草稿' }
    }
    if (batch.revision !== expectedRevision) {
      batch.draftConflict = {
        eventIds: draftEventIds,
        savedBy: CLIENT_KEY,
        savedAt: new Date().toISOString(),
        baseRevision: expectedRevision,
      }
      audit(
        'release_batch',
        batch.id,
        '提交冲突',
        `${batch.platform} 端检测到并发提交（基于修订 ${expectedRevision}，当前 ${batch.revision}），草稿已保留`,
      )
      persist()
      return {
        status: 'conflict',
        conflictWith: `该端批次已被其他窗口更新（修订 ${batch.revision}），你的草稿已保留`,
      }
    }
    // 先到方提交成功：更新批次事件范围并推进修订
    batch.eventIds = draftEventIds.filter((eventId) =>
      batch.eventIds.includes(eventId) ||
      data.value.events.some(
        (event) =>
          event.id === eventId &&
          event.platformRules.some((rule) => rule.platform === batch.platform && rule.enabled),
      ),
    )
    batch.revision += 1
    batch.submittedAt = new Date().toISOString()
    batch.submittedBy = CLIENT_KEY
    batch.draftConflict = undefined
    batch.dirty = true
    recomputeBatch(releaseId, batchId)
    return { status: 'submitted' }
  }

  /** 放弃冲突草稿（演示用） */
  const dismissBatchConflict = (releaseId: string, batchId: string): void => {
    const batch = findBatch(releaseId, batchId)
    if (!batch) return
    batch.draftConflict = undefined
    persist()
  }

  /**
   * 发布写入（模拟离线队列）：
   * - 幂等：publishKey 已存在时直接返回成功，绝不重复生成发布记录；
   * - 失败：批次停留 publishing/writeState=failed，可从该未完成批次重试；
   * - 成功：落端基线快照、生成一条发布审计记录。
   */
  const writeBatchPublish = async (
    releaseId: string,
    batchId: string,
  ): Promise<BatchPublishResult> => {
    const release = data.value.releases.find((item) => item.id === releaseId)
    const batch = release?.batches?.find((item) => item.id === batchId)
    if (!release || !batch) return { status: 'blocked', reason: '批次不存在' }
    // 幂等：该批次发布记录已落库时直接返回，绝不重复生成
    const existingKey = batch.publishKey ?? `pub:${release.id}:${batch.id}`
    if (batch.status === 'published' || data.value.publishedKeys?.includes(existingKey)) {
      batch.publishKey = existingKey
      if (batch.status !== 'published') {
        // 异常中断后的恢复：记录已落库则直接把批次收敛为已发布
        batch.status = 'published'
        batch.writeState = 'idle'
        batch.publishedAt ??= new Date().toISOString()
        syncReleaseAggregates(release)
        persist()
      }
      return { status: 'published', reason: '该批次已发布（幂等返回，未重复生成记录）' }
    }
    if (batch.dirty) return { status: 'blocked', reason: '批次契约已变更，请先重算再发布' }
    if (!batchGatesReady(batch)) {
      return { status: 'blocked', reason: '迁移确认或四角色审批尚未完成' }
    }
    if (batchReadiness(batch, validateGovernance(data.value)) < 90) {
      return { status: 'blocked', reason: '就绪度不足 90%，当前不可发布' }
    }

    const publishKey = batch.publishKey ?? `pub:${release.id}:${batch.id}`
    batch.status = 'publishing'
    batch.writeState = 'pending'
    batch.writeAttempts += 1
    batch.publishKey = publishKey
    persist()

    // 模拟异步写入失败（离线队列写失败场景）
    await new Promise((resolve) => setTimeout(resolve, 120))
    if (faultNextWrite) {
      faultNextWrite = false
      batch.writeState = 'failed'
      batch.lastWriteError = '写入发布记录失败（模拟离线队列故障），请从未完成批次重试'
      audit(
        'release_batch',
        batch.id,
        '发布写入失败',
        `${batch.platform} 端写入失败，幂等键 ${publishKey}，等待重试`,
      )
      persist()
      return { status: 'failed', reason: batch.lastWriteError }
    }

    // 成功落库：按幂等键登记去重，重试不会重复生成快照与发布记录
    const publishedKeys = data.value.publishedKeys ?? []
    const alreadyRecorded = publishedKeys.includes(publishKey)
    if (!alreadyRecorded) {
      data.value.publishedKeys = [...publishedKeys, publishKey]
      batch.eventIds.forEach((eventId) => {
        const event = data.value.events.find((item) => item.id === eventId)
        if (!event) return
        // 端基线快照，仅含该端属性
        data.value.baselines.unshift({
          id: createId('base'),
          eventId,
          version: event.version,
          properties: structuredClone(
            event.properties.filter(
              (property) =>
                !property.deletedAt && property.platforms.includes(batch.platform),
            ),
          ),
          createdAt: new Date().toISOString(),
          status: 'published',
          platform: batch.platform,
          releaseId: release.id,
          batchId: batch.id,
        })
      })
      audit(
        'release_batch',
        batch.id,
        '发布端批次',
        `${release.version}/${batch.platform} 发布成功（幂等键 ${publishKey}，第 ${batch.writeAttempts} 次尝试）`,
      )
    }

    batch.status = 'published'
    batch.writeState = 'idle'
    batch.lastWriteError = undefined
    batch.publishedAt = new Date().toISOString()
    batch.revision += 1
    syncReleaseAggregates(release)
    persist()
    return { status: 'published' }
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

  /** 回滚按端批次执行，不牵连已稳定发布的其他端 */
  const executeRollback = (
    releaseId: string,
    reason: string,
    scope: string,
    evidence: string,
    batchId?: string,
  ): RollbackRecord | undefined => {
    const release = data.value.releases.find((item) => item.id === releaseId)
    if (!release) return
    const batch = batchId
      ? release.batches?.find((item) => item.id === batchId)
      : undefined
    if (batchId && !batch) return

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
      batch.updatedAt = record.createdAt
      syncReleaseAggregates(release)
      audit('rollback', record.id, '执行端回滚', `${release.version}/${batch.platform}：${reason}`)
    } else {
      release.status = 'rolled_back'
      audit('rollback', record.id, '执行回滚', `${release.version}：${reason}`)
    }
    persist()
    return record
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
    lastSavedAt.value = new Date().toISOString()
    externalWriteNotice.value = null
  }

  /** 按端批次导出契约 */
  const exportBatchContract = (releaseId: string, batchId: string): string => {
    const release = data.value.releases.find((item) => item.id === releaseId)
    const batch = release?.batches?.find((item) => item.id === batchId)
    if (!release || !batch) return '{}'
    const batchEvents = data.value.events.filter((event) => batch.eventIds.includes(event.id))
    return JSON.stringify(
      {
        version: release.version,
        batch: batch.platform,
        generatedAt: new Date().toISOString(),
        events: batchEvents.map((event) => ({
          key: event.key,
          displayName: event.displayName,
          version: event.version,
          trigger:
            event.platformRules.find((rule) => rule.platform === batch.platform)?.trigger ??
            event.trigger,
          platform: batch.platform,
          properties: event.properties
            .filter(
              (property) =>
                !property.deletedAt && property.platforms.includes(batch.platform),
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

  const exportContract = (eventIds?: string[], platform?: Platform): string => {
    const selectedEvents = eventIds
      ? data.value.events.filter((event) => eventIds.includes(event.id))
      : data.value.events
    return JSON.stringify(
      {
        version: data.value.currentVersion,
        batch: platform ?? 'all',
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

  /** 演示用：让下一次发布写入失败，以演示“未完成批次重试且不重复生成记录” */
  const armNextWriteFailure = (): void => {
    faultNextWrite = true
  }

  /** 其他窗口（localStorage）写入后的冲突提示 */
  const notifyExternalWrite = (detail: string): void => {
    externalWriteNotice.value = detail
  }
  const clearExternalNotice = (): void => {
    externalWriteNotice.value = null
  }

  /** 跨窗口：用最新存储覆盖本地（保留当前页面，之后由查询层刷新） */
  const reloadFromStorage = (): void => {
    data.value = loadState()
    lastSavedAt.value = new Date().toISOString()
  }

  return {
    data,
    lastSavedAt,
    issues,
    externalWriteNotice,
    saveEvent,
    saveProperty,
    deleteProperty,
    savePlatformRule,
    createRelease,
    recomputeBatch,
    confirmMigration,
    updateApproval,
    submitBatchDraft,
    dismissBatchConflict,
    writeBatchPublish,
    saveDeprecation,
    executeRollback,
    verifyRollback,
    resetDemo,
    exportContract,
    exportBatchContract,
    armNextWriteFailure,
    notifyExternalWrite,
    clearExternalNotice,
    reloadFromStorage,
  }
})

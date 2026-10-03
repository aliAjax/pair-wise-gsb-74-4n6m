import type {
  GovernanceState,
  MigrationConfirmation,
  ReleaseApproval,
  ReleaseBatch,
  ReleaseCandidate,
} from '@/models/domain'
import {
  batchReadiness,
  buildReleaseBatch,
  platformsOfEvents,
} from '@/services/batches'
import { validateGovernance } from '@/services/selectors'

const CURRENT_SCHEMA_VERSION = 2

/**
 * 历史数据没有端批次：按该候选当时覆盖事件的平台规则兼容回填批次。
 * - 已发布候选：所有端批次直接标记 published/backfilled，并沿用候选发布时间；
 *   端基线回退到全端基线（baseline 无 platform 字段）。
 * - 评审中候选：按当时平台规则拆分，迁移确认与审批按端归属复用，
 *   无法明确归属的记录在各端保留，保证不丢门禁信息。
 */
const backfillBatches = (state: GovernanceState, release: ReleaseCandidate): ReleaseBatch[] => {
  const platforms = platformsOfEvents(state, release.eventIds)
  const wasPublished = release.status === 'published'

  return platforms
    .map((platform) => {
      const batch = buildReleaseBatch(
        state,
        { id: release.id, version: release.version },
        platform,
        release.eventIds,
        { backfilled: true, now: release.createdAt },
      )
      if (!batch) return null
      batch.backfilled = true

      // 迁移确认归属：依赖在该端受影响集合内则复用历史确认
      batch.migrationConfirmations = batch.migrationConfirmations.map((confirmation) => {
        const legacy = release.migrationConfirmations.find(
          (item) => item.dependencyId === confirmation.dependencyId,
        )
        return legacy
          ? ({ ...structuredClone(legacy), id: confirmation.id } satisfies MigrationConfirmation)
          : confirmation
      })

      // 历史审批是整版四角色：回填到每个端批次，保持“当时已齐”语义
      batch.approvals = release.approvals.map(
        (approval) =>
          ({
            ...structuredClone(approval),
            id: `${approval.id}-${platform}`,
          }) satisfies ReleaseApproval,
      )

      if (wasPublished) {
        batch.status = 'published'
        batch.publishedAt = release.publishedAt ?? release.createdAt
      }
      return batch
    })
    .filter((batch): batch is ReleaseBatch => Boolean(batch))
}

/**
 * 存量状态兼容升级。历史发布没有端批次时按当时平台规则回填；
 * 回填批次只用于展示与按端推进，不改变已发布事实。
 */
export const migrateState = (raw: GovernanceState): GovernanceState => {
  const state: GovernanceState = structuredClone(raw)
  // 历史发布可能没有端批次（即使种子已带 schemaVersion）：一律按当时平台规则回填
  state.releases.forEach((release) => {
    if (!release.batches || release.batches.length === 0) {
      release.batches = backfillBatches(state, release)
    }
  })
  if (!state.schemaVersion || state.schemaVersion < 2) {
    state.schemaVersion = CURRENT_SCHEMA_VERSION
  }

  // 防御性补全：任何缺字段的批次都按兼容默认值补齐
  state.releases.forEach((release) => {
    release.batches?.forEach((batch) => {
      batch.backfilled ??= false
      batch.dirty ??= false
      batch.writeState ??= 'idle'
      batch.writeAttempts ??= 0
      batch.revision ??= 1
    })
  })

  state.schemaVersion = CURRENT_SCHEMA_VERSION
  state.publishedKeys ??= []
  return state
}

/** 端批次视角的就绪度辅助（供视图便捷调用，内部走 batches 服务） */
export const readinessForPlatform = (
  state: GovernanceState,
  batch: ReleaseBatch,
): number => batchReadiness(batch, validateGovernance(state))

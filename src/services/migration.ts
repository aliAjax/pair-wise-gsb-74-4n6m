import type {
  BatchHistoryEntry,
  GovernanceState,
  PlatformBatch,
  PublicationRecord,
  ReleaseCandidate,
} from '@/models/domain'
import { createId } from '@/services/id'
import {
  computePlatformBatchForBackfill,
  platformLabel,
} from '@/services/batch'

const APPROVAL_ACTORS = { data: '顾清', product: '丁禾', client: '江驰', qa: '余安' } as const

const platformsOfRelease = (state: GovernanceState, release: ReleaseCandidate) =>
  Array.from(
    new Set(
      release.eventIds.flatMap((eventId) => {
        const event = state.events.find((item) => item.id === eventId)
        return event
          ? event.platformRules.filter((rule) => rule.enabled).map((rule) => rule.platform)
          : []
      }),
    ),
  )

const backfillEntry = (platform: PlatformBatch['platform'], detail: string): BatchHistoryEntry => ({
  id: createId('hist'),
  action: 'created',
  actor: '系统',
  detail: `${detail}：${platformLabel(platform)} 端按发布当时平台规则重建`,
  at: new Date().toISOString(),
})

/**
 * 已发布历史版本：按发布当时的平台规则为每个接入端回填一个已发布批次，
 * 迁移确认与审批视为随发布完成，并补登一条发布台账。
 */
const backfillPublishedRelease = (
  state: GovernanceState,
  release: ReleaseCandidate,
): { batches: PlatformBatch[]; publications: PublicationRecord[] } => {
  const batches: PlatformBatch[] = []
  const publications: PublicationRecord[] = []
  const publishedAt = release.publishedAt ?? release.createdAt

  platformsOfRelease(state, release).forEach((platform, platformIndex) => {
    const payload = computePlatformBatchForBackfill(state, release, platform)
    if (payload.eventIds.length === 0) return
    const batchId = createId('batch-legacy')
    batches.push({
      id: batchId,
      releaseId: release.id,
      platform,
      status: 'published',
      ...payload,
      migrationConfirmations: payload.affectedDependencyIds.map((dependencyId) => ({
        id: createId('mig-legacy'),
        dependencyId,
        version: release.version,
        status: 'confirmed',
        reviewer:
          state.dependencies.find((dependency) => dependency.id === dependencyId)?.owner ??
          '历史确认人',
        note: '历史版本随发布完成的迁移确认，兼容回填。',
        confirmedAt: publishedAt,
      })),
      approvals: (['data', 'product', 'client', 'qa'] as const).map((role) => ({
        id: createId('appr-legacy'),
        role,
        actor: APPROVAL_ACTORS[role],
        status: 'approved',
        comment: '历史发布随版审批通过，兼容回填。',
        createdAt: publishedAt,
      })),
      revision: 1,
      publishedAt,
      computedAt: release.createdAt,
      history: [backfillEntry(platform, '已发布历史版本')],
    })
    publications.push({
      id: createId('pub-legacy'),
      releaseId: release.id,
      batchId,
      version: release.version,
      platform,
      attemptId: `legacy-${release.id}-${platform}`,
      eventIds: payload.eventIds,
      operator: '历史发布人',
      publishedAt: new Date(new Date(publishedAt).getTime() + platformIndex * 1000).toISOString(),
    })
  })

  return { batches, publications }
}

/** 评审中的历史候选：按当前平台规则重建批次，迁移确认与审批沿用已有清单 */
const backfillReviewingRelease = (
  state: GovernanceState,
  release: ReleaseCandidate,
): PlatformBatch[] =>
  platformsOfRelease(state, release)
    .map((platform): PlatformBatch | null => {
      const payload = computePlatformBatchForBackfill(state, release, platform)
      if (payload.eventIds.length === 0) return null
      return {
        id: createId('batch-legacy'),
        releaseId: release.id,
        platform,
        status: 'reviewing',
        ...payload,
        migrationConfirmations: payload.affectedDependencyIds.map((dependencyId) => {
          const legacy = release.migrationConfirmations.find(
            (item) => item.dependencyId === dependencyId,
          )
          return (
            legacy ?? {
              id: createId('mig-legacy'),
              dependencyId,
              version: release.version,
              status: 'pending' as const,
              reviewer:
                state.dependencies.find((dependency) => dependency.id === dependencyId)?.owner ??
                '',
              note: '',
            }
          )
        }),
        approvals: release.approvals.map((approval) => ({ ...approval, id: createId('appr-legacy') })),
        revision: 1,
        computedAt: new Date().toISOString(),
        history: [backfillEntry(platform, '评审候选按端拆分')],
      }
    })
    .filter((batch): batch is PlatformBatch => Boolean(batch))

/** 老版本本地数据没有 batches/publications/schemaVersion 时统一兼容回填 */
export const migrateGovernanceState = (state: GovernanceState): GovernanceState => {
  const next = structuredClone(state)
  next.publications = next.publications ?? []
  let publicationsAdded = 0

  next.releases = next.releases.map((release) => {
    if (release.batches && release.batches.length > 0) return release
    const migrated: ReleaseCandidate = { ...release, batches: [] }
    if (release.status === 'published') {
      const { batches, publications } = backfillPublishedRelease(next, release)
      migrated.batches = batches
      next.publications.push(...publications)
      publicationsAdded += publications.length
    } else {
      migrated.batches = backfillReviewingRelease(next, release)
    }
    return migrated
  })

  next.schemaVersion = 2
  if (publicationsAdded > 0) {
    next.audit.unshift({
      id: createId('aud'),
      entityType: 'release',
      entityId: 'legacy',
      action: '历史端批次兼容回填',
      actor: '系统',
      detail: `检测到 ${publicationsAdded} 个历史端发布无批次记录，已按发布当时平台规则回填批次与发布台账。`,
      createdAt: new Date().toISOString(),
    })
  }
  return next
}

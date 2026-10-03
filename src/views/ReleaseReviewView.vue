<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { useQueryClient } from '@tanstack/vue-query'
import {
  AddIcon,
  CheckCircleIcon,
  ChevronRightIcon,
  CloseCircleIcon,
  DownloadIcon,
  HistoryIcon,
  RefreshIcon,
} from 'tdesign-icons-vue-next'
import { MessagePlugin } from 'tdesign-vue-next'
import PageHeader from '@/components/PageHeader.vue'
import StatusTag from '@/components/StatusTag.vue'
import { useReleaseQuery, useReleasesQuery } from '@/composables/useGovernanceQueries'
import { useBatchDraft } from '@/composables/useBatchDraft'
import type { PlatformBatch, ReleaseApproval } from '@/models/domain'
import {
  batchApprovalsReady,
  batchMigrationsReady,
  batchReadiness,
  canPublishBatch,
  platformLabel,
} from '@/services/batch'
import { createId } from '@/services/id'
import { useGovernanceStore } from '@/stores/governance'

const store = useGovernanceStore()
const queryClient = useQueryClient()
const releasesQuery = useReleasesQuery()
const releaseId = ref(
  store.data.releases.find((release) => release.status === 'reviewing')?.id ??
    store.data.releases[0]?.id ??
    '',
)
const releaseQuery = useReleaseQuery(releaseId)
const release = computed(
  () =>
    releaseQuery.data.value ??
    store.data.releases.find((item) => item.id === releaseId.value) ??
    null,
)
const releases = computed(() => releasesQuery.data.value ?? store.data.releases)
const selectedPlatform = ref<PlatformBatch['platform'] | ''>(
  release.value?.batches.find((batch) => batch.status === 'reviewing')?.platform ??
    release.value?.batches[0]?.platform ??
    '',
)
const batch = computed<PlatformBatch | null>(
  () => release.value?.batches.find((item) => item.platform === selectedPlatform.value) ?? null,
)
const readiness = computed(() => (batch.value ? batchReadiness(batch.value, store.issues) : 0))
const gate = computed(() => (batch.value ? canPublishBatch(batch.value, store.issues) : { ok: false }))

const { draftText, persistDraft, clearDraft } = useBatchDraft(() => batch.value?.id ?? 'none')

const createVisible = ref(false)
const migrationVisible = ref(false)
const approvalVisible = ref(false)
const createForm = reactive({ version: '', title: '', eventIds: [] as string[] })
const migrationForm = reactive({ confirmationId: '', reviewer: '', note: '', baseRevision: 0 })
const approvalForm = reactive({
  role: 'data' as ReleaseApproval['role'],
  actor: '',
  comment: '',
  baseRevision: 0,
})
const attemptIds = ref<Record<string, string>>({})

const eventName = (eventId: string): string => {
  const event = store.data.events.find((item) => item.id === eventId)
  return event ? `${event.displayName} (${event.key})` : eventId
}
const dependencyName = (dependencyId: string): string =>
  store.data.dependencies.find((dependency) => dependency.id === dependencyId)?.name ?? dependencyId
const roleLabel = (role: ReleaseApproval['role']): string =>
  ({ data: '数据负责人', product: '产品负责人', client: '客户端负责人', qa: '测试负责人' })[role]

const publicationsForBatch = computed(() =>
  batch.value
    ? store.data.publications.filter((record) => record.batchId === batch.value!.id)
    : [],
)

const showConflict = computed(
  () =>
    batch.value &&
    store.externalUpdate?.batchId === batch.value.id &&
    Date.now() - new Date(store.externalUpdate.at).getTime() < 60_000,
)

const invalidate = async (): Promise<void> => {
  await queryClient.invalidateQueries({ queryKey: ['release'] })
  await queryClient.invalidateQueries({ queryKey: ['releases'] })
  await queryClient.invalidateQueries({ queryKey: ['dashboard'] })
  await queryClient.invalidateQueries({ queryKey: ['lineage'] })
}

const selectBatch = (platform: PlatformBatch['platform']): void => {
  selectedPlatform.value = platform
}

const openCreate = (): void => {
  createForm.version = `2026.${String(Number(store.data.currentVersion.split('.')[1] ?? 10) + 1).padStart(2, '0')}.0`
  createForm.title = ''
  createForm.eventIds = []
  createVisible.value = true
}

const createRelease = async (): Promise<void> => {
  if (!createForm.version.trim() || !createForm.title.trim() || createForm.eventIds.length === 0) {
    await MessagePlugin.error('版本号、标题和事件范围不能为空')
    return
  }
  const created = store.createRelease(createForm.version, createForm.title, createForm.eventIds)
  releaseId.value = created.id
  selectedPlatform.value = created.batches[0]?.platform ?? ''
  createVisible.value = false
  await invalidate()
  await MessagePlugin.success(`发布候选已创建，按端拆分为 ${created.batches.length} 个独立批次`)
}

const openMigration = (confirmationId: string): void => {
  if (!batch.value) return
  const confirmation = batch.value.migrationConfirmations.find(
    (item) => item.id === confirmationId,
  )
  if (!confirmation) return
  migrationForm.confirmationId = confirmationId
  migrationForm.reviewer = confirmation.reviewer
  migrationForm.note = confirmation.note
  migrationForm.baseRevision = batch.value.revision
  migrationVisible.value = true
}

const confirmMigration = async (): Promise<void> => {
  if (!batch.value || !migrationForm.reviewer.trim() || !migrationForm.note.trim()) {
    await MessagePlugin.error('确认人和迁移说明不能为空')
    return
  }
  const outcome = store.confirmBatchMigration(
    batch.value.id,
    migrationForm.confirmationId,
    migrationForm.reviewer,
    migrationForm.note,
    migrationForm.baseRevision,
  )
  if (!outcome.ok) {
    persistDraft(`[迁移确认] ${migrationForm.reviewer}：${migrationForm.note}`)
    migrationVisible.value = false
    await MessagePlugin.error('其它窗口已先提交该端批次，你的内容已保留为草稿')
    return
  }
  migrationVisible.value = false
  await invalidate()
  await MessagePlugin.success(`${platformLabel(batch.value.platform)} 端迁移已确认`)
}

const openApproval = (approval: ReleaseApproval): void => {
  if (!batch.value) return
  approvalForm.role = approval.role
  approvalForm.actor = approval.actor
  approvalForm.comment = approval.comment
  approvalForm.baseRevision = batch.value.revision
  approvalVisible.value = true
}

const submitApproval = async (status: ReleaseApproval['status']): Promise<void> => {
  if (!batch.value || !approvalForm.comment.trim()) {
    await MessagePlugin.error('审批意见不能为空')
    return
  }
  const outcome = store.updateBatchApproval(
    batch.value.id,
    approvalForm.role,
    status,
    approvalForm.actor,
    approvalForm.comment,
    approvalForm.baseRevision,
  )
  if (!outcome.ok) {
    persistDraft(`[${roleLabel(approvalForm.role)}审批] ${approvalForm.comment}`)
    approvalVisible.value = false
    await MessagePlugin.error('其它窗口已先提交该端批次，你的意见已保留为草稿')
    return
  }
  approvalVisible.value = false
  await invalidate()
  await MessagePlugin.success(
    `${platformLabel(batch.value.platform)} 端${status === 'approved' ? '审批已通过' : '审批已驳回'}`,
  )
}

const saveDraft = async (): Promise<void> => {
  if (!batch.value) return
  if (!draftText.value.trim()) {
    await MessagePlugin.error('草稿内容不能为空')
    return
  }
  const outcome = store.saveBatchDraft(batch.value.id, draftText.value, batch.value.revision)
  if (!outcome.ok) {
    persistDraft(draftText.value)
    await MessagePlugin.error('检测到并发冲突，草稿已保留在本窗口')
    return
  }
  await invalidate()
  await MessagePlugin.success('草稿已保留，可稍后继续提交该端批次')
}

const publishOrRetry = async (): Promise<void> => {
  if (!batch.value || !release.value) return
  const id = attemptIds.value[batch.value.id] ?? createId('attempt')
  attemptIds.value[batch.value.id] = id
  const outcome = store.publishBatch(batch.value.id, id)
  if (outcome.ok) {
    if (batch.value.status === 'published') clearDraft()
    await invalidate()
    await MessagePlugin.success(
      `${release.value.version} 的 ${platformLabel(batch.value.platform)} 端已单独发布`,
    )
    return
  }
  if (outcome.reason === 'write_failed') {
    // 从未完成批次重试：attemptId 已保留，不会重复生成发布记录
    await invalidate()
    await MessagePlugin.error('写入失败，批次保留在未完成态；请修复后点击「重试发布」')
    return
  }
  if (outcome.reason === 'conflict') {
    await MessagePlugin.error('其它窗口已先提交，请刷新确认后再发布')
    return
  }
  await MessagePlugin.error(outcome.detail ?? '该端暂不满足发布门禁')
}

const toggleFailureSimulation = (value: unknown): void => {
  store.setSimulateNextPublishFailure(Boolean(value))
  if (value) void MessagePlugin.warning('已开启：下次端批次写入将模拟失败（用于验证未完成批次重试）')
}

const downloadBatchDiff = (): void => {
  if (!batch.value || !release.value) return
  const content = JSON.stringify(
    {
      release: release.value.version,
      platform: batch.value.platform,
      events: batch.value.eventIds.map(eventName),
      differences: batch.value.differences,
      affectedDependencies: batch.value.affectedDependencyIds.map(dependencyName),
      migrationConfirmations: batch.value.migrationConfirmations,
      approvals: batch.value.approvals,
      revision: batch.value.revision,
    },
    null,
    2,
  )
  const blob = new Blob([content], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `${release.value.version}-${batch.value.platform}-diff.json`
  anchor.click()
  URL.revokeObjectURL(url)
}
</script>

<template>
  <div class="page">
    <PageHeader
      eyebrow="发布门禁"
      title="按端批次发布评审"
      description="发布候选按 Web、iOS、Android、Server 拆分为独立端批次：事件或规则变化只重算受影响端，迁移与审批齐备即可单独发布；某端回滚不牵连其它端。"
    />

    <section class="panel filter-panel">
      <div class="toolbar-row">
        <div class="toolbar-field release-field">
          <span>发布候选</span>
          <t-select
            v-model="releaseId"
            :options="releases.map((item) => ({ label: `${item.version} ${item.title}`, value: item.id }))"
            @change="() => (selectedPlatform = release?.batches[0]?.platform ?? '')"
          />
        </div>
        <label class="failure-toggle" title="模拟下一次端批次写入失败，验证未完成批次重试">
          <t-switch :value="store.data.simulateNextPublishFailure" @change="toggleFailureSimulation" />
          <span>模拟下次写入失败</span>
        </label>
        <div class="filter-actions">
          <t-button variant="outline" :disabled="!batch" @click="downloadBatchDiff">
            <template #icon><DownloadIcon /></template>
            导出本端差异
          </t-button>
          <t-button theme="primary" @click="openCreate">
            <template #icon><AddIcon /></template>
            创建发布候选
          </t-button>
        </div>
      </div>
    </section>

    <template v-if="release">
      <div v-if="showConflict" class="conflict-banner">
        <CloseCircleIcon />
        <div>
          <strong>检测到并发冲突</strong>
          <span>
            其它窗口已先提交 {{ batch ? platformLabel(batch.platform) : '' }} 端批次（revision
            {{ store.externalUpdate?.theirRevision }}），你的未提交内容已保留为草稿，请合并后再提交。
          </span>
        </div>
        <t-button variant="outline" size="small" @click="store.clearExternalUpdate()">知道了</t-button>
      </div>

      <section class="panel">
        <div class="panel-header">
          <h2 class="panel-title">{{ release.version }} · {{ release.title }}</h2>
          <span class="muted">{{ release.batches.length }} 个端批次独立推进</span>
        </div>
        <div class="batch-strip">
          <button
            v-for="item in release.batches"
            :key="item.id"
            type="button"
            class="batch-chip"
            :class="{ active: item.platform === selectedPlatform }"
            @click="selectBatch(item.platform)"
          >
            <div class="chip-head">
              <strong>{{ platformLabel(item.platform) }}</strong>
              <StatusTag :value="item.status" />
            </div>
            <span>{{ item.eventIds.length }} 事件 · rev {{ item.revision }}</span>
            <t-progress
              :percentage="batchReadiness(item, store.issues)"
              :label="false"
              size="small"
              :status="batchReadiness(item, store.issues) >= 90 ? 'success' : 'warning'"
            />
          </button>
        </div>
      </section>

      <template v-if="batch">
        <section class="release-overview">
          <div>
            <span>端批次</span>
            <strong>{{ platformLabel(batch.platform) }}</strong>
            <StatusTag :value="batch.status" />
          </div>
          <div>
            <span>事件范围</span>
            <strong>{{ batch.eventIds.length }} 个</strong>
          </div>
          <div>
            <span>就绪度 / revision</span>
            <strong>{{ readiness }}% · {{ batch.revision }}</strong>
          </div>
          <div>
            <span>迁移 / 审批</span>
            <strong>
              {{ batch.migrationConfirmations.filter((m) => m.status === 'confirmed').length }}/{{
                batch.migrationConfirmations.length
              }}
              ·
              {{ batch.approvals.filter((a) => a.status === 'approved').length }}/{{
                batch.approvals.length
              }}
            </strong>
          </div>
          <t-button
            theme="primary"
            :disabled="batch.status === 'published' || batch.status === 'rolled_back'"
            @click="publishOrRetry"
          >
            <template #suffix><ChevronRightIcon /></template>
            {{ batch.status === 'publish_failed' ? '重试发布（未完成批次）' : '单独发布本端' }}
          </t-button>
        </section>

        <div v-if="batch.lastError" class="error-banner">
          <CloseCircleIcon />
          <span>{{ batch.lastError }}</span>
        </div>
        <div v-else-if="!gate.ok && batch.status === 'reviewing'" class="warn-banner">
          <span>门禁未通过：{{ gate.reason }}</span>
        </div>

        <div class="release-grid">
          <section class="panel">
            <div class="panel-header">
              <h2 class="panel-title">本端契约差异</h2>
              <span class="muted">{{ batch.differences.length }} 个事件 · 按 {{ platformLabel(batch.platform) }} 端口径</span>
            </div>
            <div class="diff-list">
              <article v-for="difference in batch.differences" :key="difference.eventId" class="diff-event">
                <div class="diff-event-head">
                  <strong>{{ difference.eventKey }}</strong>
                  <span>{{ eventName(difference.eventId) }}</span>
                </div>
                <div class="diff-columns">
                  <div class="diff-block">
                    <h4>新增与删除</h4>
                    <ul>
                      <li v-for="item in difference.addedProperties" :key="`add-${item}`">新增属性 {{ item }}</li>
                      <li v-for="item in difference.removedProperties" :key="`remove-${item}`">删除属性 {{ item }}</li>
                    </ul>
                    <span
                      v-if="difference.addedProperties.length === 0 && difference.removedProperties.length === 0"
                      class="muted"
                    >无属性增删</span>
                  </div>
                  <div class="diff-block">
                    <h4>兼容性与平台规则变化</h4>
                    <ul>
                      <li v-for="item in difference.requiredChanges" :key="item">{{ item }}</li>
                      <li v-for="item in difference.typeChanges" :key="item">{{ item }}</li>
                      <li v-for="item in difference.enumChanges" :key="item">{{ item }}</li>
                      <li v-for="item in difference.platformRuleChanges" :key="`rule-${item}`" class="rule-change">
                        {{ item }}
                      </li>
                    </ul>
                    <span
                      v-if="
                        difference.requiredChanges.length === 0 &&
                        difference.typeChanges.length === 0 &&
                        difference.enumChanges.length === 0 &&
                        (difference.platformRuleChanges?.length ?? 0) === 0
                      "
                      class="muted"
                    >本端无破坏性变化</span>
                  </div>
                </div>
              </article>
              <div v-if="batch.differences.length === 0" class="empty-state">该端批次没有契约差异。</div>
            </div>
          </section>

          <section class="panel">
            <div class="panel-header">
              <h2 class="panel-title">本端发布门禁</h2>
            </div>
            <div class="gate-list">
              <div class="gate-row">
                <CheckCircleIcon :class="{ pending: batch.differences.some((d) => (d.platformRuleChanges?.length ?? 0) > 0) }" />
                <div>
                  <strong>本端差异已重算</strong>
                  <span>{{ batch.computedAt ? new Date(batch.computedAt).toLocaleString('zh-CN') : '-' }}</span>
                </div>
              </div>
              <div class="gate-row">
                <CheckCircleIcon :class="{ pending: !batchMigrationsReady(batch) }" />
                <div>
                  <strong>本端下游迁移确认</strong>
                  <span>
                    {{ batch.migrationConfirmations.filter((m) => m.status === 'confirmed').length }}/{{
                      batch.migrationConfirmations.length
                    }} 已确认
                  </span>
                </div>
              </div>
              <div class="gate-row">
                <CheckCircleIcon :class="{ pending: !batchApprovalsReady(batch) }" />
                <div>
                  <strong>本端四角色审批</strong>
                  <span>
                    {{ batch.approvals.filter((a) => a.status === 'approved').length }}/{{
                      batch.approvals.length
                    }} 已通过
                  </span>
                </div>
              </div>
              <div class="readiness">
                <span>本端综合就绪度</span>
                <strong>{{ readiness }}%</strong>
                <t-progress :percentage="readiness" :label="false" :status="readiness >= 90 ? 'success' : 'warning'" />
              </div>
            </div>
          </section>
        </div>

        <div class="review-columns">
          <section class="panel">
            <div class="panel-header">
              <h2 class="panel-title">本端下游迁移确认</h2>
              <span class="muted">{{ batch.affectedDependencyIds.length }} 个受影响依赖</span>
            </div>
            <div class="migration-list">
              <article
                v-for="confirmation in batch.migrationConfirmations"
                :key="confirmation.id"
                class="migration-card"
              >
                <div>
                  <strong>{{ dependencyName(confirmation.dependencyId) }}</strong>
                  <span>{{ confirmation.reviewer || '未指定确认人' }}</span>
                </div>
                <StatusTag :value="confirmation.status" />
                <p>{{ confirmation.note || '尚未填写迁移确认说明。' }}</p>
                <t-button
                  variant="outline"
                  size="small"
                  :disabled="confirmation.status === 'confirmed'"
                  @click="openMigration(confirmation.id)"
                >
                  确认迁移
                </t-button>
              </article>
              <div v-if="batch.migrationConfirmations.length === 0" class="empty-state">
                本端无受影响下游依赖，迁移门禁自动满足。
              </div>
            </div>
          </section>

          <section class="panel">
            <div class="panel-header">
              <h2 class="panel-title">本端四角色审批</h2>
            </div>
            <div class="approval-list">
              <div v-for="approval in batch.approvals" :key="approval.id" class="approval-row">
                <div>
                  <strong>{{ roleLabel(approval.role) }}</strong>
                  <span>{{ approval.actor }} · {{ approval.comment || '待填写意见' }}</span>
                </div>
                <StatusTag :value="approval.status" />
                <t-button variant="text" size="small" @click="openApproval(approval)">审批</t-button>
              </div>
            </div>
            <div class="draft-bar">
              <t-input v-model="draftText" placeholder="并发冲突时保留的草稿 / 暂缓提交说明" />
              <t-button variant="outline" @click="saveDraft">保留草稿</t-button>
            </div>
          </section>
        </div>

        <div class="ledger-grid">
          <section class="panel">
            <div class="panel-header">
              <h2 class="panel-title">发布台账（幂等）</h2>
              <span class="muted">同一 attemptId 重试不重复生成记录</span>
            </div>
            <div class="ledger-list">
              <article v-for="record in publicationsForBatch" :key="record.id" class="ledger-item">
                <HistoryIcon />
                <div>
                  <strong>{{ record.version }} · {{ platformLabel(record.platform) }}</strong>
                  <span>
                    {{ record.operator }} · {{ new Date(record.publishedAt).toLocaleString('zh-CN') }}
                  </span>
                  <code>attempt: {{ record.attemptId }}</code>
                </div>
                <StatusTag value="published" />
              </article>
              <div v-if="publicationsForBatch.length === 0" class="empty-state">
                本端尚未发布；写入失败后重试沿用同一 attemptId。
              </div>
            </div>
          </section>

          <section class="panel">
            <div class="panel-header">
              <h2 class="panel-title">端批次履历</h2>
              <t-button variant="text" size="small" @click="invalidate()">
                <template #icon><RefreshIcon /></template>
                刷新
              </t-button>
            </div>
            <div class="history-list">
              <div v-for="entry in batch.history" :key="entry.id" class="history-item">
                <i></i>
                <div>
                  <strong>{{ entry.detail }}</strong>
                  <span>{{ entry.actor }} · {{ new Date(entry.at).toLocaleString('zh-CN') }}</span>
                </div>
              </div>
            </div>
          </section>
        </div>
      </template>
    </template>

    <div v-else class="panel empty-state">暂无发布候选。</div>

    <t-dialog v-model:visible="createVisible" header="创建发布候选" width="720px" :footer="false">
      <div class="editor-form">
        <div class="field">
          <label>版本号</label>
          <t-input v-model="createForm.version" />
        </div>
        <div class="field">
          <label>发布标题</label>
          <t-input v-model="createForm.title" />
        </div>
        <div class="field field-wide">
          <label>参与发布的事件（创建后按端自动拆分批次）</label>
          <t-select
            v-model="createForm.eventIds"
            :options="
              store.data.events
                .filter((event) => event.status !== 'retired')
                .map((event) => ({ label: `${event.displayName} (${event.key})`, value: event.id }))
            "
            multiple
            filterable
          />
        </div>
      </div>
      <div class="dialog-footer">
        <t-button variant="outline" @click="createVisible = false">取消</t-button>
        <t-button theme="primary" @click="createRelease">创建并按端拆分</t-button>
      </div>
    </t-dialog>

    <t-dialog v-model:visible="migrationVisible" header="确认本端下游迁移" width="620px" :footer="false">
      <div class="editor-form">
        <div class="field">
          <label>确认人</label>
          <t-input v-model="migrationForm.reviewer" />
        </div>
        <div class="field field-wide">
          <label>迁移说明</label>
          <t-textarea v-model="migrationForm.note" :autosize="{ minRows: 5, maxRows: 8 }" />
        </div>
      </div>
      <div class="dialog-footer">
        <t-button variant="outline" @click="migrationVisible = false">取消</t-button>
        <t-button theme="primary" @click="confirmMigration">确认迁移</t-button>
      </div>
    </t-dialog>

    <t-dialog v-model:visible="approvalVisible" header="提交本端审批" width="620px" :footer="false">
      <div class="selected-approval">
        <strong>{{ roleLabel(approvalForm.role) }}</strong>
        <span>{{ approvalForm.actor }}</span>
      </div>
      <div class="field">
        <label>审批意见</label>
        <t-textarea v-model="approvalForm.comment" :autosize="{ minRows: 5, maxRows: 8 }" />
      </div>
      <div class="dialog-footer">
        <t-button variant="outline" @click="approvalVisible = false">取消</t-button>
        <t-button theme="danger" @click="submitApproval('rejected')">
          <template #icon><CloseCircleIcon /></template>
          驳回
        </t-button>
        <t-button theme="primary" @click="submitApproval('approved')">
          <template #icon><CheckCircleIcon /></template>
          通过
        </t-button>
      </div>
    </t-dialog>
  </div>
</template>

<style scoped>
.filter-panel {
  padding: 14px 16px;
}

.release-field {
  min-width: 360px;
}

.failure-toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  color: #a45a00;
  font-size: 12px;
  white-space: nowrap;
}

.batch-strip {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
  gap: 12px;
  padding: 16px;
}

.batch-chip {
  display: grid;
  gap: 8px;
  padding: 13px 14px;
  border: 1px solid #dfe3e8;
  border-radius: 7px;
  background: #fafbfc;
  cursor: pointer;
  text-align: left;
}

.batch-chip.active {
  border-color: #1677ff;
  background: #eef5ff;
  box-shadow: inset 0 0 0 1px #1677ff;
}

.chip-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.chip-head strong {
  font-size: 13px;
}

.batch-chip span {
  color: #727d8f;
  font-size: 11px;
}

.conflict-banner,
.error-banner,
.warn-banner {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  border-radius: 7px;
  font-size: 13px;
}

.conflict-banner {
  justify-content: space-between;
  border: 1px solid #f2c200;
  background: #fffbe6;
  color: #7a5b00;
}

.conflict-banner > div {
  display: grid;
  gap: 3px;
}

.conflict-banner svg,
.error-banner svg {
  color: #c7362c;
}

.error-banner {
  border: 1px solid #f2b8b5;
  background: #fff7f6;
  color: #a81f17;
}

.warn-banner {
  border: 1px solid #ffd591;
  background: #fff7e8;
  color: #a45a00;
}

.release-overview {
  display: grid;
  grid-template-columns: 200px minmax(220px, 1fr) 200px 200px auto;
  align-items: center;
  gap: 1px;
  overflow: hidden;
  border: 1px solid #dfe3e8;
  border-radius: 6px;
  background: #dfe3e8;
}

.release-overview > div,
.release-overview > button {
  align-self: stretch;
}

.release-overview > div {
  display: grid;
  gap: 6px;
  padding: 14px 16px;
  background: #fff;
}

.release-overview span {
  color: #717c8e;
  font-size: 11px;
}

.release-overview > button {
  border-radius: 0;
}

.release-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.45fr) minmax(340px, 0.55fr);
  gap: 16px;
  align-items: start;
}

.diff-list {
  display: grid;
  gap: 1px;
  background: #e8ebef;
}

.diff-event {
  padding: 16px;
  background: #fff;
}

.diff-event-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin-bottom: 12px;
}

.diff-event-head strong {
  font-family: monospace;
  font-size: 12px;
}

.diff-event-head span {
  color: #737e90;
  font-size: 11px;
}

.rule-change {
  color: #a45a00;
}

.gate-list {
  padding: 10px 16px 18px;
}

.gate-row {
  display: grid;
  grid-template-columns: 30px 1fr;
  gap: 10px;
  align-items: center;
  padding: 12px 0;
  border-bottom: 1px solid #edf0f3;
}

.gate-row svg {
  color: #0f8a62;
}

.gate-row svg.pending {
  color: #c46a00;
}

.gate-row > div {
  display: grid;
  gap: 4px;
}

.gate-row strong {
  font-size: 12px;
}

.gate-row span,
.readiness span {
  color: #727d8f;
  font-size: 11px;
}

.readiness {
  display: grid;
  gap: 7px;
  padding-top: 16px;
}

.readiness strong {
  font-size: 24px;
}

.review-columns {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}

.migration-list {
  display: grid;
  gap: 1px;
  background: #e8ebef;
}

.migration-card {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 9px;
  padding: 15px 16px;
  background: #fff;
}

.migration-card > div {
  display: grid;
  gap: 4px;
}

.migration-card span,
.migration-card p {
  color: #6d788b;
  font-size: 11px;
}

.migration-card p {
  grid-column: 1 / -1;
  margin: 0;
  line-height: 1.5;
}

.migration-card :deep(.t-button) {
  grid-column: 1 / -1;
  justify-self: start;
}

.approval-list {
  display: grid;
  padding: 6px 16px;
}

.approval-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 10px;
  padding: 12px 0;
  border-bottom: 1px solid #edf0f3;
}

.approval-row > div {
  display: grid;
  gap: 4px;
}

.approval-row span {
  color: #717c8e;
  font-size: 11px;
}

.draft-bar {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 10px;
  padding: 14px 16px;
  border-top: 1px solid #e8ebef;
}

.ledger-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}

.ledger-list,
.history-list {
  display: grid;
  padding: 8px 16px 16px;
}

.ledger-item {
  display: grid;
  grid-template-columns: 22px minmax(0, 1fr) auto;
  gap: 10px;
  align-items: center;
  padding: 11px 0;
  border-bottom: 1px solid #edf0f3;
}

.ledger-item svg {
  color: #1677ff;
}

.ledger-item > div {
  display: grid;
  gap: 3px;
}

.ledger-item span,
.ledger-item code {
  color: #7a8494;
  font-size: 10px;
}

.history-item {
  display: grid;
  grid-template-columns: 14px minmax(0, 1fr);
  gap: 10px;
  padding: 8px 0;
}

.history-item i {
  width: 8px;
  height: 8px;
  margin-top: 6px;
  border-radius: 50%;
  background: #1677ff;
}

.history-item > div {
  display: grid;
  gap: 3px;
}

.history-item strong {
  font-size: 12px;
}

.history-item span {
  color: #7a8494;
  font-size: 10px;
}

.selected-approval {
  display: flex;
  justify-content: space-between;
  margin-bottom: 16px;
  padding: 12px;
  border: 1px solid #dfe3e8;
  border-radius: 6px;
  background: #fafbfc;
}

.selected-approval span {
  color: #717c8e;
  font-size: 12px;
}

.dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 22px;
  padding-top: 16px;
  border-top: 1px solid #e8ebef;
}
</style>

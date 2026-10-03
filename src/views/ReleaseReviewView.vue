<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { useQueryClient } from '@tanstack/vue-query'
import {
  AddIcon,
  CheckCircleIcon,
  CloseCircleIcon,
  DownloadIcon,
  RefreshIcon,
} from 'tdesign-icons-vue-next'
import { MessagePlugin } from 'tdesign-vue-next'
import PageHeader from '@/components/PageHeader.vue'
import StatusTag from '@/components/StatusTag.vue'
import { useReleaseQuery, useReleasesQuery } from '@/composables/useGovernanceQueries'
import { PLATFORM_LABELS, type Platform, type ReleaseApproval, type ReleaseBatch } from '@/models/domain'
import { batchGatesReady, batchReadiness } from '@/services/batches'
import { useGovernanceStore } from '@/stores/governance'

const store = useGovernanceStore()
const queryClient = useQueryClient()
const releasesQuery = useReleasesQuery()
const releaseId = ref(
  store.data.releases.find((release) => release.status === 'reviewing')?.id ??
    store.data.releases.find((release) => release.status === 'partially_published')?.id ??
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
const batches = computed<ReleaseBatch[]>(() => release.value?.batches ?? [])
const activePlatform = ref<Platform | ''>('')
const activeBatch = computed(
  () =>
    batches.value.find((batch) => batch.platform === activePlatform.value) ??
    batches.value[0] ??
    null,
)

const createVisible = ref(false)
const migrationVisible = ref(false)
const approvalVisible = ref(false)
const draftVisible = ref(false)
const createForm = reactive({
  version: '',
  title: '',
  eventIds: [] as string[],
})
const migrationForm = reactive({
  batchId: '',
  confirmationId: '',
  reviewer: '',
  note: '',
})
const approvalComment = ref('')
const singleApproval = ref<{ batch: ReleaseBatch; approval: ReleaseApproval } | null>(null)
const draftForm = reactive({ eventIds: [] as string[], expectedRevision: 0 })
const publishing = ref(false)

const readiness = computed(() =>
  activeBatch.value ? batchReadiness(activeBatch.value, store.issues) : 0,
)

const eventName = (eventId: string): string => {
  const event = store.data.events.find((item) => item.id === eventId)
  return event ? `${event.displayName} (${event.key})` : eventId
}
const dependencyName = (dependencyId: string): string =>
  store.data.dependencies.find((dependency) => dependency.id === dependencyId)?.name ?? dependencyId
const roleLabel = (role: ReleaseApproval['role']): string =>
  ({ data: '数据负责人', product: '产品负责人', client: '客户端负责人', qa: '测试负责人' })[role]

const invalidate = async (): Promise<void> => {
  await queryClient.invalidateQueries({ queryKey: ['release'] })
  await queryClient.invalidateQueries({ queryKey: ['releases'] })
  await queryClient.invalidateQueries({ queryKey: ['dashboard'] })
  await queryClient.invalidateQueries({ queryKey: ['lineage'] })
  await queryClient.invalidateQueries({ queryKey: ['validations'] })
}

const selectRelease = (id: string): void => {
  releaseId.value = id
  const next = store.data.releases.find((item) => item.id === id)
  activePlatform.value =
    next?.batches?.find((batch) => batch.status !== 'published')?.platform ??
    next?.batches?.[0]?.platform ??
    ''
}

const selectPlatform = (platform: Platform): void => {
  activePlatform.value = platform
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
  activePlatform.value = created.batches?.[0]?.platform ?? ''
  createVisible.value = false
  await invalidate()
  await MessagePlugin.success(
    `发布候选已按端创建 ${created.batches?.length ?? 0} 个批次，迁移清单按端生成`,
  )
}

const recompute = async (batch: ReleaseBatch): Promise<void> => {
  store.recomputeBatch(release.value!.id, batch.id)
  await invalidate()
  await MessagePlugin.success(`${PLATFORM_LABELS[batch.platform]} 端批次已按最新契约重算`)
}

const openMigration = (batch: ReleaseBatch, confirmationId: string): void => {
  const confirmation = batch.migrationConfirmations.find((item) => item.id === confirmationId)
  if (!confirmation) return
  migrationForm.batchId = batch.id
  migrationForm.confirmationId = confirmationId
  migrationForm.reviewer = confirmation.reviewer
  migrationForm.note = confirmation.note
  migrationVisible.value = true
}

const confirmMigration = async (): Promise<void> => {
  if (!release.value || !migrationForm.reviewer.trim() || !migrationForm.note.trim()) {
    await MessagePlugin.error('确认人和迁移说明不能为空')
    return
  }
  store.confirmMigration(
    release.value.id,
    migrationForm.batchId,
    migrationForm.confirmationId,
    migrationForm.reviewer,
    migrationForm.note,
  )
  migrationVisible.value = false
  await invalidate()
  await MessagePlugin.success('该端下游迁移已确认')
}

const openApproval = (batch: ReleaseBatch, approval: ReleaseApproval): void => {
  singleApproval.value = { batch, approval }
  approvalComment.value = approval.comment
  approvalVisible.value = true
}

const submitApproval = async (status: ReleaseApproval['status']): Promise<void> => {
  if (!release.value || !singleApproval.value || !approvalComment.value.trim()) {
    await MessagePlugin.error('审批意见不能为空')
    return
  }
  const { batch, approval } = singleApproval.value
  store.updateApproval(
    release.value.id,
    batch.id,
    approval.role,
    status,
    approval.actor,
    approvalComment.value,
  )
  approvalVisible.value = false
  await invalidate()
  await MessagePlugin.success(`${PLATFORM_LABELS[batch.platform]} 端审批已${status === 'approved' ? '通过' : '驳回'}`)
}

const publishBatch = async (batch: ReleaseBatch, injectFailure = false): Promise<void> => {
  if (!release.value) return
  if (injectFailure) store.armNextWriteFailure()
  publishing.value = true
  const result = await store.writeBatchPublish(release.value.id, batch.id)
  publishing.value = false
  await invalidate()
  if (result.status === 'published') {
    await MessagePlugin.success(`${PLATFORM_LABELS[batch.platform]} 端批次已独立发布`)
  } else if (result.status === 'failed') {
    await MessagePlugin.error(`写入失败：${result.reason}。请从该未完成批次重试，不会重复生成记录`)
  } else {
    await MessagePlugin.error(result.reason ?? '当前不可发布')
  }
}

const openDraft = (batch: ReleaseBatch): void => {
  draftForm.eventIds = [...batch.eventIds]
  draftForm.expectedRevision = batch.revision
  draftVisible.value = true
}

const submitDraft = async (): Promise<void> => {
  if (!release.value || !activeBatch.value || draftForm.eventIds.length === 0) {
    await MessagePlugin.error('批次事件范围不能为空')
    return
  }
  const result = store.submitBatchDraft(
    release.value.id,
    activeBatch.value.id,
    draftForm.eventIds,
    draftForm.expectedRevision,
  )
  draftVisible.value = false
  await invalidate()
  if (result.status === 'conflict') {
    await MessagePlugin.warning(result.conflictWith ?? '检测到并发冲突，你的草稿已保留')
  } else {
    await MessagePlugin.success('批次草稿已提交，差异已按端重算')
  }
}

const dismissDraft = async (batch: ReleaseBatch): Promise<void> => {
  store.dismissBatchConflict(release.value!.id, batch.id)
  await invalidate()
}

const downloadBatchDiff = (batch: ReleaseBatch): void => {
  if (!release.value) return
  const content = store.exportBatchContract(release.value.id, batch.id)
  const blob = new Blob([content], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `${release.value.version}-${batch.platform}-contract.json`
  anchor.click()
  URL.revokeObjectURL(url)
}

const batchIssueCount = (batch: ReleaseBatch): number =>
  store.issues.filter(
    (issue) =>
      batch.eventIds.includes(issue.entityId) &&
      (!issue.platforms || issue.platforms.includes(batch.platform)),
  ).length
</script>

<template>
  <div class="page">
    <PageHeader
      eyebrow="发布门禁"
      title="按端发布评审"
      description="发布候选按端推进：事件或平台规则变更只重算受影响端批次，迁移与审批齐备即可单独发布；写入失败从未完成批次幂等重试。"
    />

    <section class="panel filter-panel">
      <div class="toolbar-row">
        <div class="toolbar-field release-field">
          <span>发布候选</span>
          <t-select
            :value="releaseId"
            :options="releases.map((item) => ({ label: `${item.version} ${item.title}`, value: item.id }))"
            @change="selectRelease"
          />
        </div>
        <div class="filter-actions">
          <t-button
            variant="outline"
            :disabled="!activeBatch || activeBatch.status === 'published'"
            @click="activeBatch && downloadBatchDiff(activeBatch)"
          >
            <template #icon><DownloadIcon /></template>
            导出本端契约
          </t-button>
          <t-button theme="primary" @click="openCreate">
            <template #icon><AddIcon /></template>
            创建发布候选
          </t-button>
        </div>
      </div>
    </section>

    <template v-if="release">
      <section class="release-overview">
        <div>
          <span>版本</span>
          <strong>{{ release.version }}</strong>
          <StatusTag :value="release.status" />
        </div>
        <div>
          <span>端批次</span>
          <strong>{{ batches.length }} 个</strong>
          <span>{{ batches.filter((batch) => batch.status === 'published').length }} 个已发布</span>
        </div>
        <div>
          <span>当前端就绪度</span>
          <strong>{{ readiness }}%</strong>
        </div>
        <div v-if="activeBatch" class="overview-actions">
          <t-button
            v-if="activeBatch.dirty && activeBatch.status !== 'published'"
            theme="warning"
            variant="outline"
            @click="recompute(activeBatch)"
          >
            <template #icon><RefreshIcon /></template>
            重算受影响批次
          </t-button>
          <t-button
            variant="outline"
            :disabled="activeBatch.status === 'published' || activeBatch.status === 'rolled_back'"
            @click="openDraft(activeBatch)"
          >
            提交批次草稿
          </t-button>
          <t-button
            theme="primary"
            :loading="publishing"
            :disabled="
              activeBatch.status === 'published' ||
              activeBatch.status === 'rolled_back' ||
              activeBatch.writeState === 'pending'
            "
            @click="publishBatch(activeBatch)"
          >
            单独发布本端
          </t-button>
        </div>
      </section>

      <section class="panel platform-tabs">
        <button
          v-for="batch in batches"
          :key="batch.id"
          type="button"
          class="platform-tab"
          :class="{ active: activeBatch?.id === batch.id }"
          @click="selectPlatform(batch.platform)"
        >
          <div class="tab-head">
            <strong>{{ PLATFORM_LABELS[batch.platform] }}</strong>
            <StatusTag :value="batch.status" />
          </div>
          <div class="tab-meta">
            <span>{{ batch.eventIds.length }} 事件</span>
            <span :class="{ warn: batch.dirty }">{{ batch.dirty ? '待重算' : '已同步' }}</span>
            <span v-if="batch.backfilled" class="backfilled">历史回填</span>
            <span v-if="batch.writeState === 'failed'" class="write-failed">写入失败</span>
            <span v-else-if="batch.writeState === 'pending'" class="write-pending">写入中</span>
          </div>
        </button>
      </section>

      <template v-if="activeBatch">
        <section v-if="activeBatch.draftConflict" class="panel conflict-banner">
          <CloseCircleIcon />
          <div>
            <strong>提交冲突：另一窗口已更新该端批次</strong>
            <p>
              你基于修订 {{ activeBatch.draftConflict.baseRevision }} 的草稿
              （{{ activeBatch.draftConflict.eventIds.map(eventName).join('、') || '空' }}）已保留，
              当前批次为修订 {{ activeBatch.revision }}。
            </p>
          </div>
          <div class="conflict-actions">
            <t-button size="small" variant="outline" @click="openDraft(activeBatch)">
              基于最新修订重新编辑
            </t-button>
            <t-button size="small" theme="danger" variant="text" @click="dismissDraft(activeBatch)">
              放弃草稿
            </t-button>
          </div>
        </section>

        <section v-if="activeBatch.writeState === 'failed'" class="panel retry-banner">
          <CloseCircleIcon />
          <div>
            <strong>本端发布写入未完成</strong>
            <p>{{ activeBatch.lastWriteError }}（第 {{ activeBatch.writeAttempts }} 次尝试）</p>
          </div>
          <t-button size="small" theme="primary" @click="publishBatch(activeBatch)">
            从该未完成批次重试
          </t-button>
        </section>

        <div class="demo-bar">
          <t-button size="small" variant="outline" @click="publishBatch(activeBatch, true)">
            模拟下次写入失败（演示离线队列重试）
          </t-button>
        </div>

        <div class="release-grid">
          <section class="panel">
            <div class="panel-header">
              <h2 class="panel-title">{{ PLATFORM_LABELS[activeBatch.platform] }} 端契约差异</h2>
              <span class="muted">{{ activeBatch.differences.length }} 个事件在该端发生变化</span>
            </div>
            <div class="diff-list">
              <article
                v-for="difference in activeBatch.differences"
                :key="`${activeBatch.platform}-${difference.eventId}`"
                class="diff-event"
              >
                <div class="diff-event-head">
                  <strong>{{ difference.eventKey }}</strong>
                  <span>{{ eventName(difference.eventId) }}</span>
                </div>
                <div class="diff-columns">
                  <div class="diff-block">
                    <h4>新增与删除</h4>
                    <ul>
                      <li v-for="item in difference.addedProperties" :key="`add-${item}`">
                        新增属性 {{ item }}
                      </li>
                      <li v-for="item in difference.removedProperties" :key="`remove-${item}`">
                        删除属性 {{ item }}
                      </li>
                    </ul>
                    <span
                      v-if="
                        difference.addedProperties.length === 0 &&
                        difference.removedProperties.length === 0
                      "
                      class="muted"
                    >
                      无属性增删
                    </span>
                  </div>
                  <div class="diff-block">
                    <h4>兼容性变化</h4>
                    <ul>
                      <li v-for="item in difference.requiredChanges" :key="item">{{ item }}</li>
                      <li v-for="item in difference.typeChanges" :key="item">{{ item }}</li>
                      <li v-for="item in difference.enumChanges" :key="item">{{ item }}</li>
                    </ul>
                    <span
                      v-if="
                        difference.requiredChanges.length === 0 &&
                        difference.typeChanges.length === 0 &&
                        difference.enumChanges.length === 0
                      "
                      class="muted"
                    >
                      无破坏性变化
                    </span>
                  </div>
                </div>
              </article>
              <div v-if="activeBatch.differences.length === 0" class="empty-state">
                该端相对端基线没有契约差异。
              </div>
            </div>
          </section>

          <section class="panel">
            <div class="panel-header">
              <h2 class="panel-title">{{ PLATFORM_LABELS[activeBatch.platform] }} 端发布门禁</h2>
            </div>
            <div class="gate-list">
              <div class="gate-row">
                <CheckCircleIcon />
                <div>
                  <strong>端差异已生成</strong>
                  <span>{{ activeBatch.differences.length }} 个事件按该端属性比较</span>
                </div>
              </div>
              <div class="gate-row">
                <CheckCircleIcon
                  :class="{ pending: activeBatch.migrationConfirmations.some((item) => item.status !== 'confirmed') }"
                />
                <div>
                  <strong>下游迁移确认</strong>
                  <span>
                    {{
                      activeBatch.migrationConfirmations.filter((item) => item.status === 'confirmed')
                        .length
                    }}/{{ activeBatch.migrationConfirmations.length }} 已确认
                  </span>
                </div>
              </div>
              <div class="gate-row">
                <CheckCircleIcon
                  :class="{ pending: activeBatch.approvals.some((item) => item.status !== 'approved') }"
                />
                <div>
                  <strong>四角色审批</strong>
                  <span>
                    {{ activeBatch.approvals.filter((item) => item.status === 'approved').length }}/{{
                      activeBatch.approvals.length
                    }}
                    已通过
                  </span>
                </div>
              </div>
              <div class="gate-row">
                <CheckCircleIcon :class="{ pending: batchIssueCount(activeBatch) > 0 }" />
                <div>
                  <strong>该端校验问题</strong>
                  <span>{{ batchIssueCount(activeBatch) }} 项需关注</span>
                </div>
              </div>
              <div class="readiness">
                <span>综合就绪度（{{ batchGatesReady(activeBatch) ? '门禁齐备' : '门禁未齐' }}）</span>
                <strong>{{ readiness }}%</strong>
                <t-progress :percentage="readiness" :label="false" />
              </div>
            </div>
          </section>
        </div>

        <div class="review-columns">
          <section class="panel">
            <div class="panel-header">
              <h2 class="panel-title">{{ PLATFORM_LABELS[activeBatch.platform] }} 端下游迁移</h2>
            </div>
            <div class="migration-list">
              <article
                v-for="confirmation in activeBatch.migrationConfirmations"
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
                  :disabled="
                    confirmation.status === 'confirmed' || activeBatch.status === 'published'
                  "
                  @click="openMigration(activeBatch, confirmation.id)"
                >
                  确认迁移
                </t-button>
              </article>
              <div v-if="activeBatch.migrationConfirmations.length === 0" class="empty-state">
                该端批次没有受影响下游，迁移门禁自动满足。
              </div>
            </div>
          </section>

          <section class="panel">
            <div class="panel-header">
              <h2 class="panel-title">{{ PLATFORM_LABELS[activeBatch.platform] }} 端四角色审批</h2>
            </div>
            <div class="approval-list">
              <div v-for="approval in activeBatch.approvals" :key="approval.id" class="approval-row">
                <div>
                  <strong>{{ roleLabel(approval.role) }}</strong>
                  <span>{{ approval.actor }} · {{ approval.comment || '待填写意见' }}</span>
                </div>
                <StatusTag :value="approval.status" />
                <t-button
                  variant="text"
                  size="small"
                  :disabled="activeBatch.status === 'published'"
                  @click.prevent="openApproval(activeBatch, approval)"
                >
                  审批
                </t-button>
              </div>
            </div>
          </section>
        </div>
      </template>
    </template>

    <div v-else class="panel empty-state">暂无发布候选。</div>

    <t-dialog v-model:visible="createVisible" header="创建发布候选（按端拆分批次）" width="720px" :footer="false">
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
          <label>参与发布的事件（系统按各端启用规则自动生成端批次）</label>
          <t-select
            v-model="createForm.eventIds"
            :options="
              store.data.events
                .filter((event) => event.status !== 'retired')
                .map((event) => ({
                  label: `${event.displayName} (${event.key})`,
                  value: event.id,
                }))
            "
            multiple
            filterable
          />
        </div>
      </div>
      <div class="dialog-footer">
        <t-button variant="outline" @click="createVisible = false">取消</t-button>
        <t-button theme="primary" @click="createRelease">创建并按端比较</t-button>
      </div>
    </t-dialog>

    <t-dialog v-model:visible="migrationVisible" header="确认该端下游迁移" width="620px" :footer="false">
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

    <t-dialog v-model:visible="approvalVisible" header="提交端审批" width="620px" :footer="false">
      <div v-if="singleApproval" class="selected-approval">
        <strong>
          {{ PLATFORM_LABELS[singleApproval.batch.platform] }} ·
          {{ roleLabel(singleApproval.approval.role) }}
        </strong>
        <span>{{ singleApproval.approval.actor }}</span>
      </div>
      <div class="field">
        <label>审批意见</label>
        <t-textarea v-model="approvalComment" :autosize="{ minRows: 5, maxRows: 8 }" />
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

    <t-dialog v-model:visible="draftVisible" header="提交端批次草稿" width="620px" :footer="false">
      <div v-if="activeBatch" class="editor-form">
        <div class="field field-wide">
          <label>{{ PLATFORM_LABELS[activeBatch.platform] }} 端批次事件范围（基于修订 {{ draftForm.expectedRevision }}）</label>
          <t-select
            v-model="draftForm.eventIds"
            :options="
              store.data.events
                .filter(
                  (event) =>
                    event.status !== 'retired' &&
                    event.platformRules.some(
                      (rule) => rule.platform === activeBatch.platform && rule.enabled,
                    ),
                )
                .map((event) => ({ label: `${event.displayName} (${event.key})`, value: event.id }))
            "
            multiple
            filterable
          />
        </div>
        <p class="muted">若另一窗口已先提交（修订号变化），本次提交将保留为草稿并提示冲突。</p>
      </div>
      <div class="dialog-footer">
        <t-button variant="outline" @click="draftVisible = false">取消</t-button>
        <t-button theme="primary" @click="submitDraft">提交草稿</t-button>
      </div>
    </t-dialog>
  </div>
</template>

<style scoped>
.filter-panel {
  padding: 14px 16px;
}

.release-field {
  min-width: 390px;
}

.release-overview {
  display: grid;
  grid-template-columns: 180px 200px 140px minmax(280px, 1fr);
  align-items: center;
  gap: 1px;
  overflow: hidden;
  border: 1px solid #dfe3e8;
  border-radius: 6px;
  background: #dfe3e8;
}

.release-overview > div {
  display: grid;
  gap: 6px;
  align-content: center;
  min-height: 92px;
  padding: 14px 16px;
  background: #fff;
}

.release-overview span {
  color: #717c8e;
  font-size: 11px;
}

.overview-actions {
  display: flex !important;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}

.platform-tabs {
  display: flex;
  gap: 1px;
  padding: 0;
  overflow: hidden;
}

.platform-tab {
  flex: 1;
  display: grid;
  gap: 8px;
  padding: 13px 16px;
  border: 0;
  background: #fff;
  cursor: pointer;
  text-align: left;
}

.platform-tab:hover {
  background: #f7faff;
}

.platform-tab.active {
  background: #edf4ff;
  box-shadow: inset 0 -3px #1677ff;
}

.tab-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.tab-head strong {
  font-size: 13px;
}

.tab-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  color: #7a8494;
  font-size: 10px;
}

.tab-meta .warn,
.backfilled {
  color: #b65300;
}

.write-failed {
  color: #c7362c;
  font-weight: 700;
}

.write-pending {
  color: #1264c5;
  font-weight: 700;
}

.conflict-banner,
.retry-banner {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 14px 18px;
  margin-top: 16px;
}

.conflict-banner {
  border-color: #f2c2c0;
  background: #fff7f6;
}

.conflict-banner > svg,
.retry-banner > svg {
  color: #c7362c;
  flex-shrink: 0;
}

.retry-banner {
  border-color: #f0d18a;
  background: #fffaef;
}

.conflict-banner p,
.retry-banner p {
  margin: 4px 0 0;
  color: #6d788b;
  font-size: 12px;
}

.conflict-actions {
  display: flex;
  gap: 8px;
  margin-left: auto;
}

.demo-bar {
  display: flex;
  justify-content: flex-end;
  padding: 10px 2px 0;
}

.release-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.45fr) minmax(340px, 0.55fr);
  gap: 16px;
  align-items: start;
  margin-top: 16px;
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
  margin-top: 16px;
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

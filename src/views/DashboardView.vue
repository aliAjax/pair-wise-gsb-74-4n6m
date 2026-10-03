<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink } from 'vue-router'
import {
  ApiIcon,
  CheckCircleIcon,
  ChevronRightIcon,
  ErrorCircleIcon,
  FileSearchIcon,
  RefreshIcon,
} from 'tdesign-icons-vue-next'
import PageHeader from '@/components/PageHeader.vue'
import StatusTag from '@/components/StatusTag.vue'
import { useDashboardQuery, useValidationQuery } from '@/composables/useGovernanceQueries'
import { batchReadiness, platformLabel } from '@/services/batch'
import { useGovernanceStore } from '@/stores/governance'

const store = useGovernanceStore()
const dashboardQuery = useDashboardQuery()
const validationQuery = useValidationQuery()

const dashboard = computed(() => dashboardQuery.data.value)
const issues = computed(() => validationQuery.data.value ?? store.issues)
const currentRelease = computed(() => dashboard.value?.currentRelease ?? null)
const activeBatches = computed(() =>
  (currentRelease.value?.batches ?? []).filter((batch) => batch.status !== 'rolled_back'),
)
const bestBatch = computed(() =>
  [...activeBatches.value].sort(
    (left, right) => batchReadiness(right, issues.value) - batchReadiness(left, issues.value),
  )[0],
)
const readiness = computed(() =>
  bestBatch.value ? batchReadiness(bestBatch.value, issues.value) : 0,
)

const pendingBatches = computed(
  () => activeBatches.value.filter((batch) => batch.status !== 'published'),
)
const failedBatches = computed(
  () => activeBatches.value.filter((batch) => batch.status === 'publish_failed'),
)
</script>

<template>
  <div class="page">
    <PageHeader
      eyebrow="数据契约治理"
      title="事件治理工作台"
      description="聚合多端事件契约、按端批次发布门禁、校验问题与下游迁移状态。"
    />

    <section v-if="dashboardQuery.isError.value" class="load-error">
      数据加载失败：{{ dashboardQuery.error.value?.message }}
    </section>

    <div class="metrics-grid">
      <div class="metric">
        <div class="metric-label">事件契约</div>
        <div class="metric-value">{{ dashboard?.eventCount ?? store.data.events.length }}</div>
        <div class="metric-note">{{ dashboard?.draftEventCount ?? 0 }} 个草稿或评审中</div>
      </div>
      <div class="metric">
        <div class="metric-label">待推进端批次</div>
        <div class="metric-value">{{ dashboard?.batchBlocked ?? pendingBatches.length }}</div>
        <div class="metric-note">
          {{ dashboard?.batchPublished ?? 0 }}/{{ dashboard?.batchTotal ?? activeBatches.length }} 端已发布
        </div>
      </div>
      <div class="metric">
        <div class="metric-label">契约问题</div>
        <div class="metric-value danger-text">
          {{ dashboard?.validationIssueCount ?? issues.length }}
        </div>
        <div class="metric-note">{{ dashboard?.criticalIssueCount ?? 0 }} 个严重问题</div>
      </div>
      <div class="metric">
        <div class="metric-label">最就绪端批次</div>
        <div class="metric-value">{{ readiness }}%</div>
        <div class="metric-note">
          {{ bestBatch ? `${platformLabel(bestBatch.platform)} · ${currentRelease?.version ?? ''}` : '暂无评审端批次' }}
        </div>
      </div>
    </div>

    <div v-if="failedBatches.length" class="metric-note failure-note">
      <ErrorCircleIcon />
      {{ failedBatches.length }} 个端批次写入失败停留在未完成态，可在发布评审页用同一 attemptId 重试，不会重复生成发布记录。
    </div>

    <div class="dashboard-grid">
      <section class="panel release-panel">
        <div class="panel-header">
          <h2 class="panel-title">{{ currentRelease?.title ?? '发布评审' }}</h2>
          <StatusTag v-if="currentRelease" :value="currentRelease.status" />
        </div>
        <template v-if="currentRelease">
          <div class="release-summary">
            <div>
              <span>版本</span>
              <strong>{{ currentRelease.version }}</strong>
            </div>
            <div>
              <span>端批次</span>
              <strong>{{ currentRelease.batches.length }}</strong>
            </div>
            <div>
              <span>已发布端</span>
              <strong>
                {{ currentRelease.batches.filter((batch) => batch.status === 'published').length }}
              </strong>
            </div>
            <div>
              <span>受影响下游</span>
              <strong>{{ currentRelease.affectedDependencyIds.length }}</strong>
            </div>
          </div>
          <div class="batch-progress-list">
            <div v-for="batch in currentRelease.batches" :key="batch.id" class="batch-progress">
              <div class="progress-head">
                <span>{{ platformLabel(batch.platform) }} 端</span>
                <StatusTag :value="batch.status" />
                <strong>{{ batchReadiness(batch, issues) }}%</strong>
              </div>
              <t-progress
                :percentage="batchReadiness(batch, issues)"
                :label="false"
                :status="batch.status === 'published' || batchReadiness(batch, issues) >= 90 ? 'success' : 'warning'"
              />
              <small>
                迁移
                {{ batch.migrationConfirmations.filter((m) => m.status === 'confirmed').length }}/{{
                  batch.migrationConfirmations.length
                }}
                · 审批
                {{ batch.approvals.filter((a) => a.status === 'approved').length }}/{{
                  batch.approvals.length
                }}
              </small>
            </div>
          </div>
          <RouterLink to="/releases" class="release-link">
            进入按端发布评审
            <ChevronRightIcon />
          </RouterLink>
        </template>
      </section>

      <section class="panel">
        <div class="panel-header">
          <h2 class="panel-title">契约健康</h2>
          <t-button variant="text" @click="dashboardQuery.refetch()">
            <template #icon><RefreshIcon /></template>
            刷新
          </t-button>
        </div>
        <div class="health-list">
          <div class="health-row">
            <span class="health-icon success"><CheckCircleIcon /></span>
            <div>
              <strong>已发布端批次</strong>
              <span>{{ dashboard?.batchPublished ?? 0 }} 个端已独立发布</span>
            </div>
          </div>
          <div class="health-row">
            <span class="health-icon warning"><ErrorCircleIcon /></span>
            <div>
              <strong>待推进 / 写入失败端批次</strong>
              <span>
                {{ dashboard?.batchBlocked ?? pendingBatches.length }} 个待推进 ·
                {{ dashboard?.batchFailed ?? failedBatches.length }} 个写入失败
              </span>
            </div>
          </div>
          <div class="health-row">
            <span class="health-icon neutral"><FileSearchIcon /></span>
            <div>
              <strong>规则校验问题</strong>
              <span>{{ issues.length }} 项，其中严重 {{ dashboard?.criticalIssueCount ?? 0 }} 项</span>
            </div>
          </div>
          <div class="health-row">
            <span class="health-icon neutral"><ApiIcon /></span>
            <div>
              <strong>本地 API 状态</strong>
              <span>Axios 适配器正常，TanStack Query 已缓存</span>
            </div>
          </div>
        </div>
      </section>
    </div>

    <section class="panel">
      <div class="panel-header">
        <h2 class="panel-title">优先校验项</h2>
        <RouterLink to="/validation" class="text-link">查看全部</RouterLink>
      </div>
      <div class="issue-grid">
        <article v-for="issue in issues.slice(0, 6)" :key="issue.id" class="issue-card">
          <div>
            <StatusTag :value="issue.severity" />
            <span>{{ issue.kind }}</span>
          </div>
          <strong>{{ issue.title }}</strong>
          <p>{{ issue.detail }}</p>
          <small>{{ issue.suggestion }}</small>
        </article>
        <div v-if="issues.length === 0" class="empty-state">当前没有契约校验问题。</div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.load-error {
  padding: 12px 14px;
  border: 1px solid #f2b8b5;
  border-radius: 6px;
  color: #a81f17;
  background: #fff4f3;
}

.dashboard-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.2fr) minmax(360px, 0.8fr);
  gap: 16px;
}

.failure-note {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border: 1px solid #f2b8b5;
  border-radius: 7px;
  color: #a81f17;
  background: #fff7f6;
}

.release-summary {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 1px;
  background: #e6e9ee;
}

.release-summary > div {
  display: grid;
  gap: 7px;
  padding: 14px 16px;
  background: #fff;
}

.release-summary span,
.progress-head span {
  color: #6d788a;
  font-size: 11px;
}

.release-summary strong {
  font-size: 18px;
}

.batch-progress-list {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
  padding: 16px 18px 0;
}

.batch-progress {
  display: grid;
  gap: 6px;
  padding: 12px;
  border: 1px solid #e8ebef;
  border-radius: 6px;
  background: #fafbfc;
}

.progress-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.batch-progress small {
  color: #7a8494;
  font-size: 10px;
}

.release-link {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 5px;
  padding: 18px;
  color: #1264c5;
  font-size: 13px;
  text-decoration: none;
}

.health-list {
  display: grid;
  padding: 5px 16px 12px;
}

.health-row {
  display: grid;
  grid-template-columns: 38px 1fr;
  gap: 11px;
  align-items: center;
  padding: 12px 0;
  border-bottom: 1px solid #edf0f3;
}

.health-row:last-child {
  border-bottom: 0;
}

.health-icon {
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  border-radius: 6px;
  color: #49566b;
  background: #eef1f5;
}

.health-icon.success {
  color: #0e7a58;
  background: #e9f8f2;
}

.health-icon.warning {
  color: #b65300;
  background: #fff4e7;
}

.health-row > div {
  display: grid;
  gap: 4px;
}

.health-row strong {
  font-size: 12px;
}

.health-row span {
  color: #6e798b;
  font-size: 11px;
}

.issue-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 1px;
  background: #e8ebef;
}

.issue-card {
  display: grid;
  gap: 9px;
  min-height: 156px;
  padding: 15px;
  background: #fff;
}

.issue-card > div {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.issue-card > div span {
  color: #8891a0;
  font-size: 10px;
  text-transform: uppercase;
}

.issue-card p {
  margin: 0;
  color: #657084;
  font-size: 12px;
  line-height: 1.5;
}

.issue-card small {
  color: #1264c5;
  font-size: 11px;
}

.text-link {
  color: #1264c5;
  font-size: 13px;
  text-decoration: none;
}
</style>

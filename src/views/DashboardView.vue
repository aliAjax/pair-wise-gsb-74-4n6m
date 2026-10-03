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
import { PLATFORM_LABELS } from '@/models/domain'
import { batchReadiness } from '@/services/batches'
import { useGovernanceStore } from '@/stores/governance'

const store = useGovernanceStore()
const dashboardQuery = useDashboardQuery()
const validationQuery = useValidationQuery()

const dashboard = computed(() => dashboardQuery.data.value)
const issues = computed(() => validationQuery.data.value ?? store.issues)
const currentRelease = computed(() => dashboard.value?.currentRelease ?? null)

/** 当前候选各端批次概览（按端批次展示） */
const currentBatches = computed(() => currentRelease.value?.batches ?? [])

const readinessOf = (batch: (typeof currentBatches.value)[number]): number =>
  batchReadiness(batch, issues.value)

const pendingMigrations = computed(() =>
  currentBatches.value.reduce(
    (count, batch) =>
      count + batch.migrationConfirmations.filter((item) => item.status !== 'confirmed').length,
    0,
  ),
)
const pendingApprovals = computed(() =>
  currentBatches.value.reduce(
    (count, batch) =>
      count + batch.approvals.filter((item) => item.status === 'pending').length,
    0,
  ),
)
</script>

<template>
  <div class="page">
    <PageHeader
      eyebrow="数据契约治理"
      title="事件治理工作台"
      description="发布候选按端推进：迁移、审批、发布与回滚均以端批次为单位，某端变更不牵连其他稳定端。"
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
        <div class="metric-label">下游依赖</div>
        <div class="metric-value">{{ dashboard?.dependencyCount ?? store.data.dependencies.length }}</div>
        <div class="metric-note">{{ pendingMigrations }} 个端批次待迁移确认</div>
      </div>
      <div class="metric">
        <div class="metric-label">契约问题</div>
        <div class="metric-value danger-text">
          {{ dashboard?.validationIssueCount ?? issues.length }}
        </div>
        <div class="metric-note">{{ dashboard?.criticalIssueCount ?? 0 }} 个严重问题</div>
      </div>
      <div class="metric">
        <div class="metric-label">端批次发布</div>
        <div class="metric-value">
          {{ currentBatches.filter((batch) => batch.status === 'published').length }}/{{
            currentBatches.length
          }}
        </div>
        <div class="metric-note">{{ currentRelease?.version ?? '暂无评审版本' }}</div>
      </div>
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
              <strong>{{ currentBatches.length }}</strong>
            </div>
            <div>
              <span>待迁移</span>
              <strong>{{ pendingMigrations }}</strong>
            </div>
            <div>
              <span>待审批</span>
              <strong>{{ pendingApprovals }}</strong>
            </div>
          </div>

          <div class="batch-progress-list">
            <div v-for="batch in currentBatches" :key="batch.id" class="batch-progress">
              <div class="progress-head">
                <span>
                  <strong>{{ PLATFORM_LABELS[batch.platform] }}</strong>
                  <span v-if="batch.backfilled" class="backfilled-note">历史回填</span>
                  <span v-if="batch.dirty" class="dirty-note">待重算</span>
                  <span v-if="batch.writeState === 'failed'" class="failed-note">写入失败</span>
                </span>
                <span class="batch-side">
                  <StatusTag :value="batch.status" />
                  <strong>{{ readinessOf(batch) }}%</strong>
                </span>
              </div>
              <t-progress :percentage="readinessOf(batch)" :label="false" />
              <div class="batch-sub">
                迁移
                {{ batch.migrationConfirmations.filter((item) => item.status === 'confirmed').length
                }}/{{ batch.migrationConfirmations.length }} · 审批
                {{ batch.approvals.filter((item) => item.status === 'approved').length }}/{{
                  batch.approvals.length
                }}
              </div>
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
              <strong>已发布或已通过事件</strong>
              <span>{{ dashboard?.activeEventCount ?? 0 }} 个</span>
            </div>
          </div>
          <div class="health-row">
            <span class="health-icon warning"><ErrorCircleIcon /></span>
            <div>
              <strong>端批次待确认迁移</strong>
              <span>{{ pendingMigrations }} 个迁移确认跨端分布</span>
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
        <h2 class="panel-title">优先校验项（可按端在契约校验页过滤）</h2>
        <RouterLink to="/validation" class="text-link">查看全部</RouterLink>
      </div>
      <div class="issue-grid">
        <article v-for="issue in issues.slice(0, 6)" :key="issue.id" class="issue-card">
          <div>
            <span class="issue-platforms">
              <i v-for="platform in issue.platforms ?? []" :key="platform">{{
                PLATFORM_LABELS[platform]
              }}</i>
            </span>
            <StatusTag :value="issue.severity" />
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
  gap: 14px;
  padding: 16px 18px 0;
}

.batch-progress {
  display: grid;
  gap: 6px;
}

.progress-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.progress-head > span:first-child {
  display: flex;
  align-items: center;
  gap: 8px;
}

.batch-side {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.batch-side strong {
  font-size: 13px;
}

.batch-sub {
  color: #8a93a3;
  font-size: 10px;
}

.backfilled-note,
.dirty-note,
.failed-note {
  padding: 0 6px;
  border-radius: 3px;
  font-size: 10px;
}

.backfilled-note {
  color: #1264c5;
  background: #e8f1fd;
}

.dirty-note {
  color: #b65300;
  background: #fdf3e3;
}

.failed-note {
  color: #c7362c;
  background: #fdeceb;
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

.issue-platforms {
  display: flex;
  gap: 4px;
}

.issue-platforms i {
  padding: 0 6px;
  border-radius: 3px;
  color: #1264c5;
  background: #e8f1fd;
  font-size: 10px;
  font-style: normal;
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

<script setup lang="ts">
import { computed } from 'vue'
import { FilterIcon } from 'tdesign-icons-vue-next'
import StatusTag from '@/components/StatusTag.vue'
import type { Platform } from '@/models/domain'
import { platformLabel } from '@/services/batch'
import { useGovernanceStore } from '@/stores/governance'

const store = useGovernanceStore()

const releaseOptions = computed(() =>
  store.data.releases.map((release) => ({
    label: `${release.version} ${release.title}`,
    value: release.id,
  })),
)

const platformOptions = computed(() => {
  const release = store.data.releases.find((item) => item.id === store.scope.releaseId)
  return [
    { label: '全部端（候选汇总）', value: '' },
    ...(release?.batches.map((batch) => ({
      label: `${platformLabel(batch.platform)} · ${batch.eventIds.length} 事件`,
      value: batch.platform,
    })) ?? []),
  ]
})

const selectedBatch = computed(() =>
  store.scope.platform
    ? store.data.releases
        .find((release) => release.id === store.scope.releaseId)
        ?.batches.find((batch) => batch.platform === (store.scope.platform as Platform)) ?? null
    : null,
)

const setRelease = (value: unknown): void => {
  store.setScope({ releaseId: String(value), platform: '' })
}

const setPlatform = (value: unknown): void => {
  store.setScope({ releaseId: String(store.scope.releaseId), platform: (value as Platform | '') ?? '' })
}

/** 当前端批次涉及的事件 id；未选端时返回发布候选范围 */
const scopedEventIds = computed<string[] | null>(() => {
  if (!store.scope.releaseId) return null
  const release = store.data.releases.find((item) => item.id === store.scope.releaseId)
  if (!release) return null
  if (selectedBatch.value) return selectedBatch.value.eventIds
  return release.eventIds
})

defineExpose({ scopedEventIds, selectedBatch })
</script>

<template>
  <section class="panel scope-bar">
    <div class="scope-title">
      <FilterIcon />
      <span>端批次范围</span>
      <small>事件树、校验、血缘与导出均按所选端批次展示</small>
    </div>
    <div class="scope-fields">
      <div class="toolbar-field release-field">
        <span>发布候选</span>
        <t-select :value="store.scope.releaseId" :options="releaseOptions" @change="setRelease" />
      </div>
      <div class="toolbar-field platform-field">
        <span>端批次</span>
        <t-select
          :value="store.scope.platform"
          :options="platformOptions"
          @change="setPlatform"
        />
      </div>
      <div v-if="selectedBatch" class="scope-meta">
        <StatusTag :value="selectedBatch.status" />
        <span>revision {{ selectedBatch.revision }}</span>
        <span>{{ selectedBatch.migrationConfirmations.filter((m) => m.status === 'confirmed').length }}/{{ selectedBatch.migrationConfirmations.length }} 迁移</span>
        <span>{{ selectedBatch.approvals.filter((a) => a.status === 'approved').length }}/{{ selectedBatch.approvals.length }} 审批</span>
      </div>
    </div>
  </section>
</template>

<style scoped>
.scope-bar {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: center;
  gap: 18px;
  padding: 12px 16px;
}

.scope-title {
  display: flex;
  align-items: center;
  gap: 7px;
  color: #42506a;
  font-size: 13px;
  font-weight: 650;
  white-space: nowrap;
}

.scope-title svg {
  color: #1677ff;
}

.scope-title small {
  color: #8a94a5;
  font-size: 11px;
  font-weight: 400;
}

.scope-fields {
  display: flex;
  align-items: flex-end;
  gap: 12px;
  flex-wrap: wrap;
}

.release-field {
  min-width: 300px;
}

.platform-field {
  min-width: 240px;
}

.scope-meta {
  display: flex;
  align-items: center;
  gap: 10px;
  padding-bottom: 4px;
  color: #727d8f;
  font-size: 11px;
}

@media (max-width: 900px) {
  .scope-bar {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>

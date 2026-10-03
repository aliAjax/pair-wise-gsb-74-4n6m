export type Platform = 'web' | 'ios' | 'android' | 'server' | 'miniprogram'
export type EventStatus = 'draft' | 'reviewing' | 'approved' | 'published' | 'deprecated' | 'retired'
export type PropertyType = 'string' | 'number' | 'boolean' | 'array' | 'object' | 'enum'
export type ReleaseStatus = 'draft' | 'reviewing' | 'approved' | 'published' | 'rolled_back' | 'partially_published'
export type BatchStatus = 'draft' | 'reviewing' | 'approved' | 'publishing' | 'published' | 'rolled_back'
export type BatchWriteState = 'idle' | 'pending' | 'failed'
export type Severity = 'critical' | 'high' | 'medium' | 'low'

export const PLATFORM_LABELS: Record<Platform, string> = {
  web: 'Web',
  ios: 'iOS',
  android: 'Android',
  server: 'Server',
  miniprogram: '小程序',
}

export const ALL_PLATFORMS: Platform[] = ['web', 'ios', 'android', 'server', 'miniprogram']

export interface EventProperty {
  id: string
  eventId: string
  name: string
  displayName: string
  type: PropertyType
  required: boolean
  description: string
  enumValues: string[]
  owner: string
  synonyms: string[]
  platforms: Platform[]
  lineageSourceId?: string
  deletedAt?: string
}

export interface PlatformRule {
  id: string
  eventId: string
  platform: Platform
  enabled: boolean
  trigger: string
  owner: string
  requiredPropertyIds: string[]
  note: string
}

export interface EventDefinition {
  id: string
  key: string
  displayName: string
  category: string
  description: string
  trigger: string
  status: EventStatus
  version: string
  owner: string
  properties: EventProperty[]
  platformRules: PlatformRule[]
  scenarioIds: string[]
  downstreamDependencyIds: string[]
  updatedAt: string
}

export interface BusinessScenario {
  id: string
  name: string
  domain: string
  owner: string
  platform: Platform
  eventIds: string[]
  status: 'active' | 'migrating' | 'retired'
}

export interface DownstreamDependency {
  id: string
  name: string
  type: 'dashboard' | 'alert' | 'model' | 'dataset' | 'experiment'
  owner: string
  environment: 'production' | 'staging' | 'analysis'
  eventIds: string[]
  propertyRefs: Array<{ eventId: string; propertyId: string }>
  status: 'active' | 'migration_required' | 'migrated' | 'disabled'
}

export interface EventVersionSnapshot {
  id: string
  eventId: string
  version: string
  properties: EventProperty[]
  createdAt: string
  status: 'published' | 'superseded'
  /** 端批次发布产生的快照会记录所属端；历史快照无该字段，按全端兼容处理 */
  platform?: Platform
  releaseId?: string
  batchId?: string
}

export interface ContractDifference {
  eventId: string
  eventKey: string
  addedProperties: string[]
  removedProperties: string[]
  requiredChanges: string[]
  typeChanges: string[]
  enumChanges: string[]
  /** 变更属性的精确 ID（新增字段，历史数据缺省时由名称兜底） */
  changedPropertyIds?: string[]
}

export interface MigrationConfirmation {
  id: string
  dependencyId: string
  version: string
  status: 'pending' | 'confirmed' | 'rejected'
  reviewer: string
  note: string
  confirmedAt?: string
}

export interface ReleaseApproval {
  id: string
  role: 'data' | 'product' | 'client' | 'qa'
  actor: string
  status: 'pending' | 'approved' | 'rejected'
  comment: string
  createdAt?: string
}

/**
 * 按端推进的发布批次。
 * 一个发布候选下每端一个批次，差异、迁移、审批、发布和回滚均以批次为单位。
 */
export interface ReleaseBatch {
  id: string
  releaseId: string
  platform: Platform
  status: BatchStatus
  /** 本批次候选范围内的事件；published 后不可重算 */
  eventIds: string[]
  affectedDependencyIds: string[]
  differences: ContractDifference[]
  migrationConfirmations: MigrationConfirmation[]
  approvals: ReleaseApproval[]
  /** 事件或平台规则变更后仅受影响批次置脏，等待按需重算 */
  dirty: boolean
  /** 兼容回填的历史批次（当时尚无端批次结构） */
  backfilled: boolean
  /** 写入失败重试状态机：idle → pending → published；失败停留 failed */
  writeState: BatchWriteState
  writeAttempts: number
  lastWriteError?: string
  /** 幂等键：同一批次重试只能对应同一条发布记录 */
  publishKey?: string
  publishedAt?: string
  createdAt: string
  updatedAt: string
  /** 乐观锁版本；提交草稿时基于 revision 检测多窗口冲突 */
  revision: number
  submittedAt?: string
  submittedBy?: string
  /** 后到方提交时保存的草稿快照 */
  draftConflict?: {
    eventIds: string[]
    savedBy: string
    savedAt: string
    baseRevision: number
  }
}

export interface ReleaseCandidate {
  id: string
  version: string
  title: string
  status: ReleaseStatus
  eventIds: string[]
  affectedDependencyIds: string[]
  differences: ContractDifference[]
  migrationConfirmations: MigrationConfirmation[]
  approvals: ReleaseApproval[]
  createdAt: string
  publishedAt?: string
  /** 按端批次；历史数据没有批次时由迁移逻辑按当时平台规则兼容回填 */
  batches?: ReleaseBatch[]
}

export interface DeprecationPlan {
  id: string
  eventId: string
  replacementEventId?: string
  reason: string
  owner: string
  stopCollectAt: string
  retireAt: string
  status: 'planned' | 'announced' | 'stopped' | 'retired' | 'cancelled'
  migrationNote: string
}

export interface RollbackRecord {
  id: string
  releaseId: string
  /** 按端回滚时记录批次与端；历史回滚无该字段，表示当时整版回滚 */
  batchId?: string
  platform?: Platform
  version: string
  reason: string
  operator: string
  scope: string
  createdAt: string
  status: 'executed' | 'verified'
  evidence: string
}

export interface AuditEvent {
  id: string
  entityType: string
  entityId: string
  action: string
  actor: string
  detail: string
  createdAt: string
}

export interface GovernanceState {
  events: EventDefinition[]
  scenarios: BusinessScenario[]
  dependencies: DownstreamDependency[]
  baselines: EventVersionSnapshot[]
  releases: ReleaseCandidate[]
  deprecations: DeprecationPlan[]
  rollbacks: RollbackRecord[]
  audit: AuditEvent[]
  currentVersion: string
  schemaVersion: number
  /** 已成功生成发布记录的幂等键登记，保证失败重试绝不重复生成 */
  publishedKeys?: string[]
}

export interface ValidationIssue {
  id: string
  kind:
    | 'duplicate_event'
    | 'synonym_property'
    | 'naming_violation'
    | 'type_change'
    | 'deleted_property_referenced'
    | 'required_mismatch'
  severity: Severity
  title: string
  detail: string
  entityId: string
  suggestion: string
  /** 问题影响的端；缺省表示全端（历史问题兼容） */
  platforms?: Platform[]
}

export interface SampleValidationResult {
  valid: boolean
  errors: string[]
  warnings: string[]
}

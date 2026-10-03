export type Platform = 'web' | 'ios' | 'android' | 'server' | 'miniprogram'
export type EventStatus = 'draft' | 'reviewing' | 'approved' | 'published' | 'deprecated' | 'retired'
export type PropertyType = 'string' | 'number' | 'boolean' | 'array' | 'object' | 'enum'
export type ReleaseStatus = 'draft' | 'reviewing' | 'approved' | 'published' | 'rolled_back'
export type BatchStatus = 'reviewing' | 'publish_failed' | 'published' | 'rolled_back'
export type Severity = 'critical' | 'high' | 'medium' | 'low'

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

/** 平台规则快照：端批次以快照口径重算，避免规则后改牵动已发布端 */
export interface PlatformRuleSnapshot {
  ruleId: string
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
  /** 该快照由哪个端批次发布（按端推进后，同一事件版本可由多个端陆续发布） */
  platform?: Platform
}

export interface ContractDifference {
  eventId: string
  eventKey: string
  addedProperties: string[]
  removedProperties: string[]
  requiredChanges: string[]
  typeChanges: string[]
  enumChanges: string[]
  /** 平台触发规则的变化；空数组表示该端规则口径未变 */
  platformRuleChanges?: string[]
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

export type BatchHistoryAction =
  | 'created'
  | 'recomputed'
  | 'migration_confirmed'
  | 'approval_updated'
  | 'draft_saved'
  | 'publish_failed'
  | 'published'
  | 'rolled_back'

export interface BatchHistoryEntry {
  id: string
  action: BatchHistoryAction
  actor: string
  detail: string
  at: string
}

/**
 * 端批次：一个发布候选按端拆成多个独立批次。
 * 每个端有自己的差异、迁移确认、审批、版本号和发布记录，互不同步、互不牵连。
 */
export interface PlatformBatch {
  id: string
  releaseId: string
  platform: Platform
  status: BatchStatus
  /** 创建时命中的事件（该端规则启用的事件） */
  eventIds: string[]
  /** 最近一次重算口径的时间 */
  computedAt: string
  differences: ContractDifference[]
  /** 各事件在该端的规则快照，用于「事件或平台规则一改只重算受影响端」的快照对比 */
  ruleSnapshots: Array<{ eventId: string; rules: PlatformRuleSnapshot[] }>
  affectedDependencyIds: string[]
  migrationConfirmations: MigrationConfirmation[]
  approvals: ReleaseApproval[]
  /** 乐观锁：每次写入 +1，跨窗口提交靠它识别冲突 */
  revision: number
  lastError?: string
  /** 发布失败后保留的重试令牌；同令牌重试不产生新的发布记录 */
  lastAttemptId?: string
  publishedAt?: string
  draftNote?: string
  history: BatchHistoryEntry[]
}

/** 发布台账：每次端批次发布只写一条，凭 attemptId 幂等 */
export interface PublicationRecord {
  id: string
  releaseId: string
  batchId: string
  version: string
  platform: Platform
  attemptId: string
  eventIds: string[]
  operator: string
  publishedAt: string
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
  /** 按端推进的发布批次；历史数据经 repository 按当时平台规则回填 */
  batches: PlatformBatch[]
  createdAt: string
  publishedAt?: string
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
  /** 按端回滚时记录具体端批次；整版历史回滚为空 */
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
  /** 端批次发布台账，一次端发布一条，重试不重复 */
  publications: PublicationRecord[]
  audit: AuditEvent[]
  currentVersion: string
  /** 本地数据结构版本，用于历史数据兼容回填 */
  schemaVersion: number
  /** 演示用：下一次端批次写入是否模拟失败，检验从未完成批次重试 */
  simulateNextPublishFailure: boolean
}

export const GOVERNANCE_SCHEMA_VERSION = 2

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
}

export interface SampleValidationResult {
  valid: boolean
  errors: string[]
  warnings: string[]
}

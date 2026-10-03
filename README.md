# EventRail 多端埋点事件治理与发布评审平台

基于 Vue 3、TDesign、Pinia、Vue Router、TanStack Query、Axios、Vite 与 TypeScript 的独立前端工程。项目使用 Axios 自定义本地适配器模拟契约 API，查询缓存由 TanStack Query 管理，业务编辑状态由 Pinia 持久化到浏览器 `localStorage`。

## 功能

- 按业务域维护事件树、多端触发规则、属性和负责人
- **发布候选按端（Web / iOS / Android / Server）拆分为独立端批次推进，互不牵连**
- 事件或某端平台规则一改，只重算受影响端的非终态批次；终态批次不被牵动，实质变更后该端会签重置
- 迁移确认与四角色审批按端独立门禁，齐备的端可单独发布；按端回滚不影响其它已发布端
- 事件树、校验、属性血缘、契约导出均按所选端批次范围展示
- 端批次写入失败停留未完成态，凭同一 attemptId 幂等重试，发布台账绝不重复生成
- 端批次 revision 乐观锁：两个窗口同时提交同一端，后到方被拒并保留草稿、看到冲突横幅（跨标签页 storage 同步）
- 历史发布单无端批次时，按发布当时平台规则兼容回填批次、审批、迁移与发布台账
- 属性类型、枚举、必填条件、同义字段和跨事件血缘
- 重复事件、同义属性、命名越界、类型变化与删除字段引用检查
- JSON 示例的类型、枚举和必填规则校验
- 发布候选契约比较、受影响下游依赖和迁移确认
- 事件废弃计划、替代事件和迁移说明
- 发布回滚记录与结果验证
- JSON 契约和 Markdown 契约文档导出

## 运行

```bash
npm install
npm run dev
```

默认开发地址为 `http://localhost:18474`。

## 构建与验证

```bash
npm run build     # 类型检查 + 生产构建
npm run verify    # 端批次纯规则（8 项）+ store 幂等/乐观锁/隔离（4 项）验证
```

`npm run verify` 通过 esbuild 即时运行 `scripts/verify-batch.ts` 与 `scripts/verify-store.ts`，覆盖按端拆分、只重算受影响端、attemptId 幂等发布、revision 并发冲突、按端回滚隔离与历史数据回填。

## 数据层

- `src/services/batch.ts`：端批次推导、按端契约差异/影响分析、受影响端重算、门禁与就绪度
- `src/services/migration.ts`：历史发布单按当时平台规则兼容回填
- `src/services/api.ts`：Axios 实例与本地 API 适配器
- `src/services/repository.ts`：本地持久化（schema 兼容回填）与跨窗口 storage 同步
- `src/composables/useGovernanceQueries.ts`：TanStack Query 查询组合
- `src/stores/governance.ts`：端批次编辑、按端门禁、幂等发布、写入失败重试、乐观锁冲突、回滚与导出
- `src/services/selectors.ts`：契约比较、影响分析和校验规则

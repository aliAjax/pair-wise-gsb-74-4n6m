# EventRail 多端埋点事件治理与发布评审平台

基于 Vue 3、TDesign、Pinia、Vue Router、TanStack Query、Axios、Vite 与 TypeScript 的独立前端工程。项目使用 Axios 自定义本地适配器模拟契约 API，查询缓存由 TanStack Query 管理，业务编辑状态由 Pinia 持久化到浏览器 `localStorage`。

## 功能

- 按业务域维护事件树、多端触发规则、属性和负责人
- 属性类型、枚举、必填条件、同义字段和跨事件血缘
- 重复事件、同义属性、命名越界、类型变化与删除字段引用检查（可按端批次过滤）
- JSON 示例的类型、枚举和必填规则校验（支持按端契约）
- **发布候选按端推进**：Web/iOS/Android/Server/小程序各自独立端批次
  - 事件或平台规则变更后，只把受影响的未发布端批次置脏并按需重算
  - 迁移确认与四角色审批按端门禁，齐备即可单独发布，其他端不受牵连
  - 事件树、校验、血缘、契约导出均按端批次展示
  - 发布写入失败时批次停留未完成状态，从该批次幂等重试，不重复生成发布记录
  - 两个窗口并发提交同一端时，后到方保留草稿并看到冲突（revision 乐观锁 + storage 同步）
  - 回滚按端批次执行，不影响其他已稳定发布的端
- 历史数据没有端批次时，加载时按当时平台规则兼容回填（端基线缺失时回退全端基线）
- 事件废弃计划、替代事件和迁移说明
- JSON 契约和 Markdown 契约文档导出（可按端/按已生成批次导出）

## 运行

```bash
npm install
npm run dev
```

默认开发地址为 `http://localhost:18474`。

## 构建

```bash
npm run build
```

## 数据层

- `src/services/api.ts`：Axios 实例与本地 API 适配器
- `src/composables/useGovernanceQueries.ts`：TanStack Query 查询组合
- `src/stores/governance.ts`：Pinia 编辑、按端批次发布/重试/冲突、废弃和回滚状态
- `src/services/batches.ts`：端批次构建、按端差异、受影响依赖、就绪度与状态聚合
- `src/services/migration.ts`：历史数据端批次兼容回填（按当时平台规则）
- `src/services/selectors.ts`：契约比较、影响分析和校验规则
- `scripts/verify-batches.ts`、`scripts/verify-store.ts`：端批次逻辑与发布幂等/冲突的 node 冒烟验证


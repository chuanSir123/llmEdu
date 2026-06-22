# llmEdu 维护指南

## 项目概览
- 这是一个教务 SaaS / 租户化 DSL 平台，后端使用 Fastify + TypeScript + PostgreSQL，前端使用 React + Vite。
- 租户业务数据存放在独立 PostgreSQL schema 中；平台管理和 DSL 元数据主要存放在 `admin` schema。
- 前端页面多由 DSL 驱动：菜单、页面、接口、动作、权限和导入导出能力都可能来自 seed 或租户定制后的 DSL。

## 常用目录
- `src/main.ts`：Fastify 路由入口、认证后 schema 解析和租户接口聚合。
- `src/seed/data.ts`：模块、功能、页面、动作和 DSL seed 的主要定义来源。改页面入口、按钮、默认 DSL 时通常要同步这里。
- `src/seed/run.ts`：执行 seed，把 `src/seed/data.ts` 的定义写入数据库。
- `src/gateway/`：DSL 菜单、页面、动作和 API 执行层。
- `src/permission/`：页面、按钮、字段和数据权限。
- `src/tenant/`：租户创建、AI 定制、预览测试库、附件和定制记录服务。
- `src/agent/`：AI 定制 harness、规划、校验、执行预览等逻辑。
- `client/src/renderers/`：通用 DSL 页面渲染器和 AI 定制相关面板。
- `client/src/api/GatewayClient.ts`：前端访问后端接口的集中客户端。

## 关键业务约定
- 正式租户 schema 形如 `t_xxx`；AI 预览测试库使用同租户 schema 加 `_test` 后缀，例如 `t_xxx_test`。
- 租户用户允许访问自己的正式 schema 和自己的 `_test` 预览 schema；不能访问其他租户 schema。
- `_test` 预览 schema 只用于预览和验证结果，不能再次发起 AI 定制生成流程。
- 只有 `_test` 后缀的预览测试机构才应该隐藏 AI 定制入口；正式租户即使名称中包含 `test` 也不应被误过滤。
- AI 记录按 `record_type` 区分：`customization` 是 AI 定制记录，`assistant` 是 AI 助手记录。
- AI 定制记录页面当前标准编码是 `customization_record_list`，AI 助手记录页面当前标准编码是 `assistant_record_list`；不要再新增或误用 `tenant_customization_record` 指向同一租户记录页。
- AI 定制入口按钮使用 `actionType/type: "open_ai_customization"`，前端应由 `GenericPageRenderer` 调用 `onOpenAiCustomization` 打开面板。
- 定制记录详情接口应返回 `{ record }`，其中字段为前端驼峰格式：`schemaName`、`sessionId`、`changeSummary`、`skillMd`、`chatTimeline`。

## 修改注意事项
- 改 seed 时，要同时确认生成的 page DSL、action DSL 和前端渲染器是否都支持对应 action type。
- 改租户访问控制时，不要简单比较请求 schema 与登录 schema；要考虑同租户 `_test` 预览 schema。
- 不要让 AI 定制 chat / stream / publish 等生成类接口在 `_test` schema 中运行；这类接口已有显式保护时不要移除。
- 改详情类接口时，前后端返回结构必须保持一致，前端也要对空记录、旧数据和缺字段做兜底，避免白屏。
- 不要在 import 周围添加 try/catch。

## 推荐检查命令
- `npm run check`：TypeScript 检查后端和前端。
- `npm run build`：完整构建前后端和前端静态资源。
- `npm run check:harness`：AI 定制 harness 回归检查。
- `npm run db:migrate`：执行数据库迁移。
- `npm run db:seed`：写入 seed 数据。

## 调试建议
- 遇到“不能访问其他租户数据”，优先检查 `src/main.ts` 的 schema 解析和调用方传入的 `schemaName` 是否是同租户 `_test` 预览 schema。
- 遇到菜单/入口消失，优先检查 `src/seed/data.ts`、`src/gateway/menu.service.ts`、租户订阅表和权限表。
- 遇到白屏，优先检查浏览器控制台运行时异常、前后端字段命名是否一致，以及 DSL 渲染器是否对缺字段做了兜底。

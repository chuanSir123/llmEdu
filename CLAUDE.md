# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概览

AI 可定制的多租户教务 SaaS（营销/招生/教务/财务四大模块）。后端 Fastify + TypeScript + PostgreSQL，前端 React + Vite + Tailwind。核心理念：**前端只有一套通用 DSL 渲染器，页面/菜单/接口/按钮/权限全部由数据库中的 DSL 驱动**；租户通过 AI 定制（自然语言 → DSL diff → 校验 → 预览 → 发布）修改自己的系统，不改代码。

另见 `AGENTS.md`（关键业务约定与调试建议）、`docs/hardcode-audit-backlog.md`（已知硬编码待优化清单）。

## 常用命令

```bash
npm run dev              # 启动开发服务（tsx src/main.ts，127.0.0.1:3000）
npm run check            # TypeScript 检查后端 + 前端（改完必跑）
npm run check:harness    # AI 定制 harness 回归（55 个用例，需要 DB，改 agent/ 后必跑）
npm run build            # 完整构建（后端 tsc + 前端 vite build）
npm run db:migrate       # 数据库迁移（migrator.ts 内是幂等 ALTER/CREATE IF NOT EXISTS）
npm run db:seed          # 写入 seed（模板机构 demo_school 的默认 DSL 与数据）
npm run verify:db        # migrate + seed + harness + 核心 smoke 流程全跑
npm run smoke:business-flow   # 单个 smoke（tsx src/smoke/tenant-business-flow.ts，见 package.json 其余 smoke:*）
npm run eval:harness     # AI 定制 golden 评测集
```

依赖 Docker：`docker-compose.yml` 提供 PostgreSQL（127.0.0.1:15432）和 Redis（127.0.0.1:16379）。环境变量见 `src/config/env.ts`（DATABASE_URL、REDIS_URL、JWT_SECRET、TEMPLATE_SCHEMA、LLM_* 等，都有开发默认值）。运行时 LLM 配置存 `admin.llm_config` 表（模型/温度/超时/重试均可按租户配置），不是 env。

没有单元测试框架；测试 = harness 回归（`src/agent/harness-regression.ts`，纯函数断言 + 需 DB 的用例）+ smoke 脚本（走真实 HTTP/DB 流程）。给 harness 加用例：在 harness-regression.ts 的 `tests` 数组加 `{ name, run }`。

## 架构（大图）

### 多租户 schema 模型

- `admin` schema：平台元数据——所有 DSL 表（page_dsl/api_dsl/action_dsl/import_dsl/report_dsl/skill_registry/business_rule）、版本（dsl_version）、租户（tenant_manage）、LLM 配置、审计。
- 每个租户一个 PG schema（如 `t_xxx`）存业务数据；`{tenant}_test` 是 AI 预览测试库（只用于预览，禁止在其中发起 AI 定制）。
- **模板机构**（`TEMPLATE_SCHEMA`，默认 demo_school，`src/common/template-schema.ts`）是所有 DSL 的继承基线：几乎所有 DSL 查询都是"租户覆盖行优先，模板行兜底"的 order-by-case 模式。改动 DSL 查询时保持这个双层结构。
- `src/seed/data.ts` 是模板机构默认 DSL 的唯一来源（页面/接口/动作/规则/字典字段映射）；改页面入口、按钮、默认 DSL 通常要同步这里。

### 请求执行链

```
前端 GenericPageRenderer（client/src/renderers/）
  → /api/gateway/api/execute（main.ts，做 canAccessPage 页面权限）
    → executeGatewayApi（gateway/api-executor.ts）
        ├─ executeConfigApi：配置类接口的 apiCode 分发（业务规则/审批流/微信/商城等）
        ├─ query-dsl-engine：查询类 DSL → SQL（数据权限按 dsl.security.dataPermission
        │    → permission.service.getOrganizationScope 注入 where）
        └─ command-engine：业务命令（合同/收款/扣费/退费/排课，事务 + Redis 锁 +
             business_rule 驱动分配算法 + 审批触发）
    → business-event.service：命令/接口 → 领域事件 → 规则联动（通知/待办/营销）
```

权限四层：页面（`canAccessPage`）、按钮（`visibleActionCodes` / `canExecuteApiOnPage`）、字段（`fieldPermissions`）、数据（`security.dataPermission`，档位见 `common/dsl-constants.ts` 的 `DATA_PERMISSION_LEVELS`）。**AI 助手工具（tenant-assistant）与前端按钮同权限口径**——新增助手工具时必须补 canAccessPage/canExecuteApiOnPage。

### AI 定制 harness（src/agent/）

流水线：`harness-runner.ts` 编排 意图分类 → 上下文注入（skill.md + 真实表结构）→ 需求规划 → 领域工具/变更规划（产出 DslDiff[]）→ 校验修复 → 预览执行（写 `_test` schema + draft 版本）。

- 迭代预算来自 `tenant_agent_config.execution_policy`（外层规划轮次/修复轮次/超时/单轮工具调用数），不要写死轮次；有错误指纹卡死检测（连续两轮相同错误 → 强制刷新上下文 → 仍相同则提前终止）。
- 修复是**工具循环**（`agent-tools.ts`）：模型可调 `get_table_columns`/`get_dsl_content`/`validate_draft_diffs` 自查后再经 `plan_changes` 提交；不支持 tool calling 时回落单轮生成。
- 校验分层：`validators/tenant-policy.validator.ts`（租户策略）+ `validators/edu-domain.validator.ts`（教务护栏：财务派生字段保护、数据隔离、命令契约）+ `db/dsl-validator.ts`（对真实 schema 校验字段存在）。
- `rules/edu-rules.ts` 是教务规则的"单一真相源注册表"（规则 ↔ 错误码 ↔ prompt 提示），新增规则应落这里。
- 发布走 `version/version.service.ts`：dsl_version draft → active，可回滚；预览库结构由 `tenant/test-schema.service.ts` 从源 schema 重建。

### AI 助手（src/tenant/tenant-assistant.service.ts）

对话式业务操作：query_data / analyze_data / execute_business_api / navigate / plan_excel_import / execute_excel_import 工具。Excel 导入支持多文件、单文件多 sheet、固定依赖顺序（学员→合同→收款→排课→扣费→退费）；**跨 sheet 依赖 ID 通过"名称→DB 解析"传递**（validate_import 逐项先导先入库），纯校验模式用 `pendingForeignNames` 容忍前序未落库的名称。外键解析走 `import.service.ts` 的单次运行缓存（`ForeignOptionCache`）。

### 共享常量（改一处生效，不要再复制）

- `common/template-schema.ts`：模板 schema 名（勿再写死 demo_school 字面量）
- `common/dsl-constants.ts`：系统字段集、数据权限档位、核心业务规则清单（判定优先读 rule_json.coreRule 元数据）
- `common/field-type.ts`：字段类型推断（生成与校验共用）
- `common/foreign-key-meta.ts`：外键 → 目标表/接口/显示字段元数据（8+ 文件依赖）

## 关键约定（来自 AGENTS.md，务必遵守）

- 租户用户可访问自己的正式 schema 和自己的 `_test` 预览 schema；改租户访问控制时不要简单比较 schema 相等。
- 只有 `_test` 后缀的预览机构才隐藏 AI 定制入口；AI 定制 chat/stream/publish 等生成类接口禁止在 `_test` schema 运行。
- AI 记录按 `record_type` 区分：`customization`（定制）/ `assistant`（助手）；页面编码分别是 `customization_record_list` / `assistant_record_list`。
- 详情类接口返回 `{ record }`，字段用前端驼峰格式；前端对空记录/缺字段做兜底防白屏。
- 不要在 import 周围添加 try/catch。
- 改 seed 时同步确认 page DSL、action DSL、前端渲染器三方支持对应 action type。
- 前端动作语义优先读 DSL 的 `action.variant`/显式配置，`.delete` 等后缀约定仅兜底（`client/src/dsl/actionVariant.ts`）。

# 硬编码审计 backlog（阻碍租户 AI 定制的写死点）

> 2026-07 全库审计产出。已完成的第一批收敛见文末"已完成"；本文档保留**尚未处理**的深水区项，
> 按 ROI 排序。原则：把「代码里的 if/switch/Map/魔法字符串」下沉为
> business_rule / 字典 / registry 元数据 / DSL 字段，让 AI 定制改数据即可生效。

## P0 — 直接限制定制能力

### 1. 外键元数据写死（影响面最大）
`src/common/foreign-key-meta.ts` 把 15 组外键关系 + `*_staff_id→user` 后缀规则硬编码，
被 8+ 文件消费（query-dsl-engine、page.service、diff-executor、domain-tools、import.service、
validation-repair、tenant-assistant、preview-dry-run）。
- 问题：租户 AI 新增表/外键字段后，下拉、`_name` 显示、导入解析、校验修复全部失效。
- 方向：外键注册表落库（`admin.foreign_key_registry`，租户行 + 系��默认行），
  `inferForeignKeyMeta` 先查租户注册再回落静态默认；`create_table`/`add_field`
  发布时自动登记。page DSL 的 `optionSource` 已可覆盖推断，可作为过渡。

### 2. 命令引擎 dispatch 与算法写死
`src/gateway/command-engine.ts`：命令→处理函数三元链（246-273）、`simpleCommands` 表、
事务/Redis 锁白名单、`commandApprovalHint`（127-138）、业绩五五分成 `* 0.5`（716、752）、
折扣 `(10-value)/10`（393、546）、`paidStatus` 判定、大量 `'FINISHED'/'CANCELLED'` 状态内联。
- 方向：命令注册表（command → handler/needsTx/needsLock/defaultRuleCode/approvalHint 元数据）；
  分成比例、折扣基数、审批触发条件（`promotion_amount > 0`）移进 business_rule 参数；
  状态判断改读字典 `metadata.businessSemantic/systemSemantic`（字典已标注但引擎未消费）。

### 3. api-executor 巨型 apiCode 分发链
`src/gateway/api-executor.ts` `executeConfigApi` ~70 个 `if (apiCode === ...)` 分支 +
`businessCommandMap`（apiCode→command→ruleCode 写死）。
- 方向：`command`/`ruleCode` 放进 api_dsl.dsl_json（operation 已存在，扩展即可）；
  配置类接口收敛为 handler 注册表。

### 4. 数据权限归属字段写死
`src/permission/permission.service.ts` `getOrganizationScope`：`own_students → owner_user_id/study_manager_id`、
`own_courses → teacher_id/study_manager_id`、`self_only → created_by` 列名硬编码。
- 方向：每个 data_permission 档位的归属字段列表可配置（字典 metadata 或专表），
  拼 SQL 前校验列存在（参考 query-dsl-engine 的 tableColumns.has 防御）。

### 5. 校验器白名单跟不上租户新表
`src/agent/validators/edu-domain.validator.ts`：`TENANT_SCOPED_TABLES`（13 张表）、
`PROTECTED_FINANCE_WRITE_FIELDS`（16 字段）静态清单。
- 问题：租户新建业务表不在清单里 → 数据隔离校验静默跳过；护栏覆盖率随定制递减。
- 方向：运行时查 information_schema 判断表是否含 organization_id 列；
  派生/只读字段标记下沉到 db_schema 字段元数据（`derived:true`），清单只作兜底。

## P1 — 重复定义 / 展示层特判

### 6. 前端 GenericPageRenderer pageCode 特判
`client/src/renderers/GenericPageRenderer.tsx`：`course_week_schedule` 默认周区间、
`contract_list` 编辑前反查 hydrate、`approval_task_list` 详情组件/logs 加载、
审批 approve/reject apiCode 写死。
- 方向：DSL 增加 `hydrate[]`、`detailRenderer`、`filters[].defaultRange="current_week"`、
  `presentation.approval.approveApi` 等声明式配置。

### 7. enrollment / calendar 布局硬编码业务模型
报名页（GenericPageRenderer 95-403、885-1101）写死 `product_ids/promotion_id/REDUCE/DISCOUNT` 与算法；
CalendarView 写死 `course_date/teacher_id/FINISHED/CONFIRMED` 与六项统计。
- 方向：`presentation.enrollment.sections` / `presentation.calendar.{dateField,summaryMetrics,hoverFields}` 配置化；
  着色统一走 `dictionaryMeta[].tone`。

### 8. 菜单二级分组靠 pageCode 子串猜测
`src/gateway/menu.service.ts` `group()`：`pc.includes("contract") → "合同收费"` 等。
- 方向：feature_registry 增加 group_code/group_name 列，菜单直接读。

### 9. 版本服务 DSL 类型映射三份重复
`src/version/version.service.ts`：`DSL_TABLE_MAP` / `DSL_SOURCES` / `initializeTenantVersion.dslTables`
同一份 targetType→表映射写三遍。
- 方向：单一 `DSL_RESOURCE_REGISTRY` 导出，所有函数遍历。

### 10. 角色/支付方式默认值双份
四个默认角色及权限在 `seed/run.ts` 与 `tenant-create.service.ts` 各一份；
`pay_way_config` 同样两份；`roleCode === "PRINCIPAL"` 特判散落。
- 方向：默认角色/支付集合抽共享常量；PRINCIPAL 特权改 capability flag。

### 11. 事件映射写死
`src/gateway/business-event.service.ts`：`BUSINESS_COMMAND_EVENT_MAP` / `BUSINESS_API_EVENT_MAP` /
`KNOWN_BUSINESS_COMMANDS` 硬编码，租户自定义命令无法挂事件。
- 方向：api_dsl/command 元数据加 `emitEvent` 字段。

### 12. 招生流转与文案写死
`src/recruit.service.ts`：`stageFromFollowResult` 映射、`'首次跟进'/'试听课'` 默认文案。
- 方向：映射进 lead_stage 字典 metadata；文案走规则模板参数。

## P2 — 前端兜底与杂项

- 字段格式化/合计/图片列按字段名正则猜测（GenericTableRenderer 27/106/18-21）→
  `field.format/summable/decimals` 显式控制，正则仅兜底。
- BusinessRuleEditor 规则分类与开关 key 前端写死 → ruleSchema 由后端下发。
- ApprovalTaskDetail 状态/字段中文映射写死 → 走 valueLabels + 字段 DSL label。
- WechatPortalPage `schemaName="demo_school"`、卡片字段写死（若定位演示页可后置）。
- 系统字典 label 全量 locked → 区分"值锁定"与"标签可改"，允许租户改显示名（如"顾问"→"课程规划师"）。
- prompts.ts 静态块内联 demo_school 表字段示例 → 方法论保留，具体示例迁到动态上下文。
- `edu-rules.ts` 单一真相源已建但未消费（文件头自陈）→ 推进 prompt/validator 从注册表生成。
- 报表默认时间字段/中文标签映射（diff-executor 471-523）→ 按物理列类型探测 + 字段 label。
- tenant-create 默认密码 `123456` → env 配置 + 强制首登改密。

## 已完成（第一批收敛，2026-07）

1. **tenant-policy bug 修复**：`allowed_target_types`/`risk_policy` 从 DB 读出后不再被默认值覆盖；
   `allowedTargetTypes` 真正接入 tenant-policy.validator 校验。
2. **风险评估接上策略**：`requiresManualReview/requiresConfirmation` 由
   `publishPolicy.requireAdminReview` 与 `riskPolicy(auto|confirm|manual)` 驱动，不再恒 false。
3. **模板 schema 常量化**：新增 `src/common/template-schema.ts`（`TEMPLATE_SCHEMA`，
   `TEMPLATE_SCHEMA` env 可配），替换 22 个文件 130+ 处 `demo_school` 字面量。
4. **共享常量收敛** `src/common/dsl-constants.ts`：系统字段（4 处→1）、数据权限枚举+优先级
   （4 处→1）、核心规则清单（3 处→1，判定优先读 rule_json.coreRule/locked 元数据）。
5. **字段类型推断统一** `src/common/field-type.ts`：diff-executor/domain-tools/validator
   三份不一致实现合一（时间类优先于金额类）。
6. **LLM 配置化**：`llm_config` 新增 `request_timeout_ms`/`max_retries` 列，
   超时与重试不再写死 120s/3 次。
7. **moduleLabel 读 module_registry**（60s 缓存），删除内联中文模块名表。
8. **字典双格式兼容统一**：`dictionaryCompatValues` 收敛 auth.service 与 query-dsl-engine
   的 `ACTIVE/status.ACTIVE` 判断，且对所有系统字典字段通用（不再只特判 status）。
9. **字典字段别名合并**：`DICTIONARY_FIELD_ALIASES` 导出，seed/data.ts 复用。
10. **前端动作语义显式化**：`client/src/dsl/actionVariant.ts`，危险色/"更多"菜单
    优先读 `action.variant`，`.delete` 后缀仅兜底；`requiresSelectionMessage` 可由 DSL 配置
    （原写死"请先选择学员"）。

验证：`npm run check` 通过；`npm run check:harness` 52/52 通过。

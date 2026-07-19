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
- 方向：每个 data_permission 档位的归属字段列表可配置（字典 metadata 或专表）。
- ✅ 已完成（2026-07-18）"拼 SQL 前校验列存在"：getOrganizationScope 接收目标表列集合，
  归属列缺失时回落校区维度、再缺失视为共享字典表不加过滤（此前教师角色打开学员/收款页
  直接 `column t.teacher_id does not exist` SQL 报错）；organization 表 t.id 重映射保留。
  归属字段列表可配置仍为待办。

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
11. **动态默认值 sentinel（2026-07-16）**：DSL `defaultValues` 支持 `"$now"`/`"$today"`，
    由 GenericPageRenderer 在打开弹窗时解析为本地当前时间/日期；seed 中所有
    `new Date().toISOString()`（seed 时刻被固化进 DSL）与写死日期（`course_dates: ["2026-07-12"]`
    等）均已替换。同批修复：移除 `pay_way_config_id: "pay_cash"` 等悬空默认
    （demo_school 业务主数据 ID 被 seed remap 成数字，`pay_cash` 不存在，提交会写入悬空外键）；
    `.edit` 行按钮尊重内联 `fields`/`apiCode`（编辑排课的 courseEditFields 此前被忽略）；
    query-dsl-engine 为 generic_course 聚合 `student_ids`（编辑排课回填上课学员）；
    course_delete 对已取消课程真正软删（原先返回成功但行永远留在列表）；
    charge_record 工具栏补上「新增扣费」（action/modal/SKILL.md 均已有，仅页面缺入口）。

12. **教务/财务断头路与字典前缀比较收敛（2026-07-17/18）**：
    - 电子账户支付不扣余额：`pay_way_type` 在库中为字典 ID 形态（`pay_way_type.ELE_ACCOUNT`），
      command-engine 4 处 `str(...) === "ELE_ACCOUNT"` 改为 `dictBare(...)` 比较；
    - 审批流被静默绕过：前端编辑写入 `status.ACTIVE`，触发查询只匹配裸值 `ACTIVE`，
      两处 approval_flow 状态查询改为双格式匹配（**同类隐患：任何对库中字典字段的裸值 SQL 比较**）；
    - 审批任务页无审批按钮：page DSL rowActions 未包含 approve/reject/cancel（仅 primaryRowActions 引用），
      已补齐并去掉无意义的新增/编辑/删除；
    - 删除排课要求填原因但 UI 无输入：`requireDeleteReason` 规则开启时按钮是纯 confirm，
      已改为带必填"删除原因"的弹窗（已取消课程直删不需原因）；
    - 删除请假不复位考勤：新增 `leave.delete` 命令，LEAVE 考勤复位 PENDING（已扣费则阻断提示）；
    - 周课表/班级学员/1对N学员错误配置 `softDelete: false`（三张表均软删）→ 已删课程/已移出学员永远显示；
    - 班级学员/1对N学员页补"所属班级/小组"字段（FK 名称显示+可筛选），班级/小组列表补成员跳转，
      学员列表补"合同"跳转（学员→财务链路）。

13. **历史流水名称保留（2026-07-18）**：query-dsl-engine 的 FK 名称子查询与页面 join
    原本过滤 `deleted = false`——学员/支付方式/产品等主数据删除后，收款/扣费/合同等历史
    记录的名称列全部变空白。已改为不过滤（left join + 主键等值，无重复行风险），符合
    财务审计"历史显示保留"惯例。同轮：charge_record 补"课程/扣费时间"列；
    foreign-key-meta 增加 `*_course_id` 后缀推断（补课管理原课程/补课课次显示名称）。
    待办：预存余额目前只能通过"作废预存收款"退出，可考虑增加 refund_type=ELE_ACCOUNT
    的正式退预存路径（字典 + createRefund 扩展 + 弹窗字段联动）。

14. **按钮权限落到 UI（2026-07-18）**：page.service 下发页面 DSL 时按 visibleActionCodes
    过滤 toolbar/rowActions——此前按钮权限只在后端执行时兜底（受限角色能看到全部按钮，
    点击才报 403）。有 "*"（page_permission=all / 管理员）时行为不变；demo 四个角色目前
    均为 all，租户可通过角色管理配置受限角色后即刻生效（已实测：read + 显式按钮清单 →
    未授权按钮从 DSL 消失 + 直调 API 403 双层拦截）。
    ✅ demo 角色矩阵常规化已完成（2026-07-18）：seed/run.ts `roleButtonPermission` 按
    模块+动作白名单差异化——教师=考勤/请假/补课/跟进（排课与财务只读）、学管=教务/学员/
    招生/审批全操作（财务与系统配置只读）、顾问=招生全操作+学员建档报名、校长=全部；
    canExecuteApiOnPage 同步补齐了 page_dsl 内联按钮的 apiCode 解析（含 .create/.edit/.delete
    → createApi/updateApi/deleteApi 约定），否则受限角色被授权的内联按钮会被误拒。
    已逐角色实测：授权操作放行、未授权 403、UI 按钮同步隐藏。

15. **字段权限真正生效（2026-07-18）**：`field_permission`（如教师 `contact: hidden`）此前
    仅随 page 响应下发 fieldPermissions 元数据，前端和数据层都不执行——受限角色照样看到
    手机号。现三层落地：page.service `applyFieldPermissions` 从列/弹窗/筛选/按钮内联字段
    中剥除 hidden、readonly 置只读；main.ts execute 路由读取响应剥 hidden 字段
    （rows/record/顶层）、写入丢弃 hidden/readonly 字段（防直调绕过）。管理员与空配置零开销。

16. **合同收款学员一致性校验（2026-07-18）**：createFunds 此前接受"合同 A + 学员 B"的
    错配收款——流水挂 B 名下、资金却分配到 A 的合同，对账必乱（收款弹窗学员可自由改选，
    极易误触）。已在 command-engine 增加签约学员一致性断言；正常路径（弹窗 mapRow 注入、
    预存无合同、导入）不受影响。

17. **已收款合同禁换签约学员（2026-07-18）**：updateContract 此前允许把已收款/已扣费
    合同的 student_id 改到别的学员——收款流水与课消仍挂原学员，合同归属却换了人。
    已加断言（有收款→"请先删除收款或走退费重签流程"；有扣费同理）；未收款合同仍可换。

18. **删除学员护栏（2026-07-18）**：student_list.delete 此前是裸软删——名下有生效合同、
    电子账户余额、未取消排课照删不误，留下无主资金与课表。新增 `student.delete` 命令：
    三项前置校验（生效合同→先退费/删合同；余额→先作废预存或退余额；排课→先处理课程），
    干净学员正常删除。12 步闭环的清理步骤（先删合同再删学员）不受影响。

19. **主数据删除引用护栏（2026-07-18）**：产品/支付方式/校区/优惠此前可被裸删——
    被合同、流水、学员引用照删（教师账号 user.softDelete 已有护栏，主数据没有）。
    query-dsl-engine 的 delete 分支新增 `DELETE_REFERENCE_GUARDS` 引用检查表
    （product←contract_product、pay_way_config←funds/refund、organization←学员/合同/
    在排课程/员工、promotion←contract_product），命中拒绝并提示"如需停用请改为编辑状态"；
    未被引用的记录正常删除。新增引用关系时在该表补一行即可。

20. **合同收款超额护栏（2026-07-18）**：createFunds 此前对 CONTRACT_PAY 不校验应收
    余额——超额收款把 paid_amount 推过应收（总额-优惠），报表口径全乱。已加校验：
    超出剩余应收拒绝并提示"超出部分请改用学员预存"；足额精确通过、收满后再收拒绝；
    预存（PRE_STORE）不受合同限制。负数/零金额收款、负退费、负扣费此前已有护栏（复测通过）。

21. **手动扣费幽灵路径修复（2026-07-18）**：charge_record.create 传入未知 charge_type
    （如 COURSE_CHARGE）会绕过全部余额校验/剩余扣减，落下 CONFIRMED 但金额 0、不动
    合同产品的"幽灵扣费"。createCharge 现在：扣费类型白名单校验；负数/双零课时金额拒绝；
    同课程同学员防重复扣费（与考勤扣费同口径）；未填金额按剩余金额/剩余课时折算单价
    （扣课时必扣钱）。同轮把 command-engine 14 处 `charge_status = 'CONFIRMED'` 裸值比较
    改为兼容 `charge_status.CONFIRMED` 字典形态（seed 原生扣费记录此前对所有护栏隐身！
    合同修改锁定、重复扣费检测、课程删除冲销都会漏判）。

22. **字典前缀失配系统性清扫（2026-07-18）**：继 pay_way_type/审批流 status/charge_status
    后全库扫描裸值字典比较，再修 7 处：审批人解析（staff_type/role_code/assigneeRole 三方
    都可能带前缀 → currentApproverUserId 恒 null，"当前用户不是此节点审批人"护栏形同虚设，
    修复后逐节点校验真正生效）；优惠查询 ×2（status.ACTIVE 优惠静默失效）；线索转正
    （student_status.LEAD 签约后不转 FORMAL）；退费入账检测 change_type；导入/AI 助手的
    合同 ACTIVE 判断；待办审批视图 PENDING。经验：**新写任何字典字段的 SQL 比较必须
    双格式 `in ('X','<dict>.X')` 或 dictBare()**——该 bug 类已累计捕获 21 处。

验证：`npm run check` 通过；`npm run check:harness` 52/52 通过。

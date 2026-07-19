# 声明式校验规则（AI 定制新增业务规则的实现方案）

> 2026-07-15 落地。目标：租户通过 AI 定制或规则设置页**新增**业务规则（不只是改已有规则键的值），
> 且平台不给任何租户新增逻辑代码。

## 设计思路

系统原有规则分两类：

1. **引擎旗标类**（`promotionAllocation`、`absentCharge`、`preventTeacherTimeConflict`…）——引擎认识的固定键，租户只能改值，不能新增语义；
2. **workflow 事件监听类**（`category=workflow`）——事件触发既有 command，已经是声明式，但只覆盖"事后联动"，覆盖不了"事前拦截"。

缺的是第三类："**新增一条事前校验**"（单次扣课时上限、仅正式学员可排课、每日排课数上限……）。
方案：**规则即数据，解释器即平台代码**——新增受控的声明式校验解释器，规则以 JSON 存
`admin.business_rule`（`category=validation` + `validations` 数组），平台在业务命令事务内、
命令执行前逐条求值，不通过则抛 422 阻断（整体回滚）。AI 定制"新增规则"= 生成一行规则数据，零代码。

### 安全模型（核心约束）

- **只能收紧，不能放宽**：解释器在命令前追加校验；引擎内置防护（余额校验/状态机/时间冲突/CP 归属）
  始终在命令内部执行，声明式规则无法绕过或关闭它们。
- **无任意代码**：操作符白名单、context 实体白名单、count_limit 表白名单、regex 长度上限、
  单规则最多 20 条校验；字段路径正则约束，SQL 仅由平台模板拼接（qIdent + 参数化）。
- **同一事务**：与 command-engine 共用 client，规则拦截 → 命令整体回滚，无半途副作用。
- **三层同一套结构校验**（`validateDeclarativeRuleJson` 单一真相源）：
  AI 定制 diff 校验（edu-domain.validator）→ 规则保存接口（saveBusinessRule）→ 运行时白名单兜底。

## 规则结构

```jsonc
{
  "ruleCode": "charge_hour_cap_rule",
  "ruleName": "单次扣课时上限",
  "category": "validation",          // 或 categories 数组含 "validation"
  "businessType": "charge_create",   // 决定拦截哪个业务命令（见下方映射）
  "validations": [
    // 字段校验：field/valueField 支持入参字段、data.xxx、context.<实体>.<列>
    { "field": "charge_hour", "operator": "<=", "value": 2,
      "message": "单次扣课时不能超过2",
      "when": [{ "field": "charge_type", "operator": "=", "value": "NORMAL" }] },
    // 上下文实体校验（按入参 ID 惰性加载 student/contract/contract_product/course/product/organization）
    { "field": "context.student.student_status", "operator": "=", "value": "FORMAL",
      "message": "仅正式学员可排课" },
    // 数组入参逐项校验（attendance.checkIn 的 students）
    { "each": "students", "field": "charge_hour", "operator": "<=", "value": 1.5,
      "message": "考勤单次扣课时不能超过1.5" },
    // 计数上限（表白名单 + 必须带 where，禁止全表计数）
    { "type": "count_limit", "table": "generic_course_student",
      "where": [{ "field": "student_id", "valueFrom": "student_id" }],
      "operator": "<", "value": 10, "message": "学员排课数已达上限" }
  ]
}
```

- **操作符**：`= != > >= < <= in not_in exists required regex min_length max_length`；
  `no_time_overlap`/`unique` 为引擎原生操作符——结构校验放行、解释器跳过（由 preventXxx 旗标兜底）。
- **求值语义**：比较类操作符左值为空 → 规则不适用直接通过（避免部分更新误拦）；必填语义显式用 `required`。
  字典项 ID 形态（`charge_type.NORMAL`）与裸值等价比较。
- **businessType → 命令映射**：`COMMAND_BUSINESS_TYPES`（declarative-rules.ts），覆盖
  contract/funds/refund/charge/attendance/course/leave/makeup/班级学员 等全部教务财务命令，含历史别名。

## 代码落点

| 文件 | 职责 |
|---|---|
| `src/common/declarative-rules.ts` | 类型、白名单、纯函数求值（evaluateFieldCheck/compareRuleValues）、结构校验（validateDeclarativeRuleJson）。common 层避免 gateway↔agent 循环依赖 |
| `src/gateway/declarative-rule.service.ts` | 运行时解释器：加载规则（模板/租户两层，双字典形态匹配）、惰性加载 context 实体、count_limit 参数化计数、`runDeclarativeValidations` 入口 |
| `src/gateway/command-engine.ts` | 两个事务包裹处（simpleFn 分支与主分支）在 `maybeSubmitApprovalTask` 前调用 `runDeclarativeValidations` |
| `src/gateway/api-executor.ts` | saveBusinessRule 保存前结构校验（validations 跳过字典归一化，保留结构 DSL 原始形态） |
| `src/agent/validators/edu-domain.validator.ts` | AI 定制 create_business_rule diff 的同套结构校验 |
| `src/agent/prompts.ts` | 声明式规则结构、操作符、context/each/count_limit 用法与示例（模型据此生成规则） |
| `src/agent/rules/edu-rules.ts` | 注册 `declarative_validation_rule` 规则条目（触发词：限制/上限/不允许/必须满足…） |

## 测试

- `npm run smoke:declarative-rule`（已加入 verify:db）——7 用例端到端：坏结构被拒、
  when 前置扣课时上限、context 学员状态门槛、count_limit 排课上限、each 考勤逐项、
  删除规则后放行、内置余额防护不被放宽。
- harness 回归 +3 用例（62/62）：结构校验好坏形状、求值器语义（空跳过/when/each/字典兼容/原生跳过）、
  guardrails 拦截坏 diff。

## 边界与后续

- 声明式规则当前只做**事前拦截**；事后联动继续用 workflow 事件规则，二者组合覆盖"新增业务逻辑"的绝大多数诉求。
- context 实体按"入参约定 ID 字段"加载（如 `student_id` → student）；批量命令（attendance.checkIn）
  的 context 基于顶层入参，`each` 内暂不支持逐项加载各自的 context 实体，需要时可扩展。
- 规则设置页（business_rule_list）已能对 validation 规则做增删改；如需更友好的结构化编辑器，
  可后续按 `validateDeclarativeRuleJson` 的约束生成表单 DSL。

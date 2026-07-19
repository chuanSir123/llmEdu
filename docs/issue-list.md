# llmEdu 问题清单

> 第一轮：2026-07-12，所有页面和接口的显示、业务规则执行（9 项，已修复 ✓，详情见 git 历史）
> 第二轮：2026-07-15，教务财务链路专项静态审计（52 项，已修复 ✓，随提交 6a62201 落库）
> 第三轮：2026-07-15，启动服务运行时调试（本文档，全部已修复 ✓）

---

# 第三轮：运行时调试（启动服务，实测 62 个页面 + 教务财务全业务流）

> 方法：启动 dev 服务，脚本遍历租户菜单全部 62 个页面（page DSL 加载、dataApi 执行、列与返回字段一致性、
> 选项接口可用性、动作类型可路由性），再在临时租户上通过 HTTP 网关跑教务财务全链路 22 步断言
>（签约→收款→排课→考勤→扣费→改判→取消考勤→改合同→退费→删退费→整单退费→收款防护→改期→取消排课）。

## 发现并修复的问题

### 1.【高】修改合同 HTTP 500：sign_time 时间戳序列化错误 ✓
- **文件**：`src/gateway/command-engine.ts`（updateContract）
- **现象**：不传 sign_time 修改合同时，回退值 `str(contract.sign_time)` 把 pg 返回的 Date 对象串成
  `"Wed Jul 15 2026 17:50:26 GMT+0800 (中国标准时间)"`，写回 timestamptz 列直接报
  `invalid input syntax for type timestamp with time zone`，**修改合同功能整体不可用**（存量 bug）。
- **修复**：回退值原样传 `input.sign_time ?? contract.sign_time`，不做字符串化。

### 2.【高】DATE 列时区偏移：日期列显示/按天分组会差一天 ✓
- **文件**：`src/db/pool.ts`
- **现象**：pg 默认把 date 列解析成本地午夜的 JS Date，JSON 序列化后变 UTC ISO
  （本地 2026-07-21 → `"2026-07-20T16:00:00.000Z"`）。前端按字符串截取日期（表格日期列、周课表按天分组）会**偏移一天**。
- **修复**：`pg.types.setTypeParser(1082, v => v)`，DATE 列按原始 `YYYY-MM-DD` 文本返回。

### 3.【高】字典项 ID 形态值绕过状态防护与条件求值 ✓
- **文件**：`src/gateway/command-engine.ts`、`client/src/dsl/conditions.ts`
- **现象**：接口入参经 normalizeDictionaryInputValues 会归一成字典项 ID 形态（`course_type.ONE_ON_ONE_COURSE`）
  落库，与命令内部写入的裸值（`CANCELLED`）混存。导致：
  - 后端 `=== "CANCELLED"` / `=== "REFUNDED"` 等状态判断对点号形态失效（已取消课程可再修改、已退费合同防护穿透）；
  - SQL `course_status <> 'CANCELLED'`（老师/学员时间冲突、future 课关联）与 `= 'SCHEDULED'`（停课批量处理）漏匹配；
  - 前端 visibleWhen/enabledWhen 与裸值不相等，状态防护按钮凭空消失。
- **修复**：后端所有状态分支经 `dictBare` 归一；course_type/course_status 落库前归一为裸值；
  状态类 SQL 同时匹配两种形态；前端条件求值器对两侧值做 `bareDictValue` 归一。

### 4.【中】合同产品列表缺"已分配优惠"列 ✓
- **文件**：`src/seed/data.ts`（contract_product_list）
- **现象**：优惠分摊数据正确（复核 DB：两笔收款各分摊 50+50，合计恰好 200），但页面没有
  `paid_promotion_amount` 列，财务无法核对优惠分配，也让排查时误以为分摊逻辑失效。
- **修复**：contract_product_list 增加"已分配优惠"列。

## 验证结果（本轮修复后复测）

- 62 页结构体检：0 问题（page DSL 加载、dataApi 执行、列字段一致性、选项接口、动作类型全部正常）
- 业务流 HTTP 端到端：22/22 通过（含首付入账、优惠分摊不重复、排款不超计划、改判不重复扣费、
  取消考勤课时恢复、改合同后 CP 重链考勤可用、退费防护、删退费冲回负业绩、REFUNDED 拒收款、
  改期后 id 过滤、已取消课程拒绝考勤）
- `npm run check` 前后端 tsc 通过
- `npm run check:harness` 59/59 通过
- smoke：business-flow / reversal-flow / refund-flow / core-import-flow / module-selection 全部 ok

---

# 第二轮问题存档（2026-07-15 静态审计，52 项全部已修复，代码见提交 6a62201）

## 后端账务逻辑（command-engine.ts）
1.【高】多笔收款重复分配优惠 ✓ — arrangePromotion 改为按本笔收款占应收比例分摊、封顶未分配额、收齐清尾。
2.【高】考勤重复扣费 ✓ — 本课次已有 CONFIRMED 扣费只更新考勤状态（幂等）。
3.【高】删除退费不冲回负业绩 ✓ — refund.delete 软删 sourceRefundId 关联的 REFUND_REVERSE。
4.【高】修改合同后排课引用悬空 ✓ — 重建 CP 后按产品映射重链 generic_course_student。
5.【高】已退费合同仍可收款 ✓ — createFunds 增加合同状态防护。
6.【中】排款上限口径错误 ✓ — 改为 计划-计划优惠-已排款。
7.【中】单品退费缺字段/不支持电子账户 ✓ — 补 refund_type/contract_id/organization_id + ELE_ACCOUNT 入账。
8.【中】整单退费电子账户入账不对称 ✓ — REFUND_IN 改为逐条退费记录入账。
9.【中】REVERSED 扣费永久锁死合同修改 ✓ — 引用检查只统计 CONFIRMED。
10.【中】删除收款无退费防护 ✓ — 已有退费拒绝删除，作废留痕 ext_json。
11.【中】扣费/退费不校验 CP 归属 ✓。
12.【中】手工排款无事务且不同步 paid_* ✓。
13-18.【低/补】0 课时清零条件、签约首付走真实流水、编辑合同换学员、考勤返回值、course.cancel 防护、新增 course.update 命令 ✓。

## 权限口径
19.【高】canExecuteApiOnPage 识别 modal submitApiCode（含 modalCode 引用）✓。
20.【高】网关对变更类接口增加按钮级权限校验（与助手同口径）✓。

## 页面 DSL（seed）
21-33. 修改排课缺失、跨页 filterField 失效（合同详情收款记录全量！）、状态防护 visibleWhen、排课日期时间列、
charge/refund/cp 列表数据权限、必填标注、detail 指向只读弹窗、危险按钮 action_dsl 权限行、新增合同入口、
importCode、周课表假按钮、student_visit 误用 apiCode、course_list.edit 指向错误 ✓。

## 前端渲染器
34-47. 提交防重、onToolbar execute_api、open_modal 缺 fields 防误执行、required/afterSuccess/enabledWhen/modalCode
四项 DSL 能力落地、下拉远程搜索、周课表翻周重查+行动作、visibleWhen 操作符、危险操作确认兜底、考勤请假选项、
页码越界回退、跨 tab 联动刷新、本页合计口径、prepare 报错透出、打印分支、金额右对齐等 ✓。

## 回归阶段追加修复（在未改动的 main 上同样复现的存量问题）
48.【高】字典项 ID 形态绕过业务分支（导入扣费不扣课时）✓ — dictBare 归一。
49.【高】删除收款业绩残留 ✓ — 软删同口径。
50.【中】新建租户勾选功能被整模块覆盖 ✓。
51.【中】contract_type 字典缺课程形态值 ✓。
52.【低】date_range 过滤不接受标量日期 ✓。

---

# 第一轮问题存档（2026-07-12，9 项全部已修复）

1. customization_record_list 页面 subtitle 被错误覆盖 ✓
2. admin 页面误用 tenant_customization_record 编码 ✓
3. _test schema 下 AI 助手按钮可见但面板无法打开 ✓
4. _test schema 下 AI 定制入口按钮未隐藏 ✓
5. onRowAction 未处理 open_ai_customization 类型 ✓
6. GenericPageRenderer setRows/setTotal 空值兜底 ✓
7. GenericTableRenderer formatValue 死代码 ✓
8. action-executor 类型缺 open_ai_customization ✓
9. apiSchema=admin 的 fixedFilter schemaName 未校验归属 ✓

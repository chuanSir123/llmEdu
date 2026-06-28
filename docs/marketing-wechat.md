# 营销模块与微信公众号集成设计

## 已落地能力

1. 平台管理员在 `admin.wechat_third_platform_app` 维护第三方平台应用的 Component AppID、授权发起域名和统一回调域名；`/api/wechat/component/callback` 会验签/解密统一回调并写入 `component_verify_ticket`。
2. 平台管理员在 `admin.public_wechat_account` 维护公有化服务号；新租户初始化会写入默认 `wechat_account_binding` 和 `wechat_menu_config`。
3. 租户可以在公众号绑定页发起“扫码授权”：`wechat.authorizeUrl.create` 会生成授权 URL 并保存到 `qr_auth_url`；`wechat.authorization.callback` 用于完成授权状态落库。
4. 租户可以在公众号菜单页发布菜单：`wechat.menu.publish` 会使用 authorizer access token 调用微信公众号菜单发布接口，并把发布结果回写到本地菜单记录。
5. 学员和微信粉丝通过 `wechat_student_fan` 绑定，保存 openid、unionid、头像、微信名和关注状态。
6. 微信推送规则通过 `wechat_push_rule.rule_json` 配置；`wechat.template.send` 会按规则字段映射调用微信模板消息接口，支付回调和既有合同/收款/扣费/退费命令会触发营销事件匹配并落发送日志。
7. 学员端 H5 已提供 `/租户/wx/home`、`/租户/wx/mall`、`/租户/wx/me` 三个入口，底部 Tab 固定为：首页、商城、我的。
8. 商城支持商品、活动、团购团单、参团明细和订单；`mall.order.create` 使用 Redis 分布式锁创建订单并锁库存，`mall.order.payCallback` 幂等处理支付成功并生成合同和收款流水，`mall.order.close` 调用微信支付关单并回补库存，`mall.order.refund` 调用微信退款、生成退款记录并触发退款通知。

## 学员端页面

- 首页：展示我的课表、请假记录、合同、就读班级。
- 商城：展示上架商品、商品详情、秒杀/团购活动、活动价、库存和进行中的团购团单，支持创建微信 JSAPI 支付订单并由真实支付回调完成交易。
- 我的：展示学员主档、openid 绑定信息、头像/微信名、我的老师和退出登录。

## 商城业务对象

- `mall_goods`：商品，可绑定既有产品 `product_id`。
- `mall_activity`：营销活动，支持 `SECKILL` 秒杀、`GROUP_BUY` 团购和普通活动规则字段。
- `mall_group_buy`：团购团单，记录团长、成团人数、已参团人数、状态、过期和成团时间。
- `mall_group_member`：参团明细，记录团单、订单、学员和成员状态。
- `mall_order`：订单，保存微信支付交易号、支付回调载荷、生成合同和收款记录的关联 ID。

## 生产化接入点

当前命令已改为直接调用微信官方接口；admin 第三方平台字段按明文存储，便于直接改库联调；营销交易、教务扣费/退费等关键命令依赖 Redis 分布式锁和关键余额表 `lock_version` 乐观锁。上线前需要在 admin 配置和公众号 ext_json 中补齐以下真实参数：

- `wechat.authorizeUrl.create`：用真实 `pre_auth_code` 生成授权 URL。
- `wechat.menu.publish`：调用公众号自定义菜单创建接口。
- `wechat.template.send`：调用模板消息或订阅通知接口。
- `mall.order.payCallback`：依赖原始 JSON body、微信支付回调 header、平台证书和 `api_v3_key` 完成验签与回调解密。


## 并发控制

- Docker Compose 默认包含 Redis，服务端通过 `REDIS_URL` 连接。
- 商城下单、支付回调、关单、退款使用 Redis 分布式锁保护订单/商品/活动并发。
- 教务考勤扣费、取消扣费、收款、退费、合同删除等关键命令通过 Redis 命令锁串行化；`contract_product`、`student_ele_account` 等关键余额表增加 `lock_version`，扣费/退费更新时会做乐观锁校验。

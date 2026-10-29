# ERP 接入修改申请（待用户批准）

日期：2026-10-26。本文仅存于插件仓库，未改动 ERP 项目。

状态：用户已回复“暂不修改 ERP，先交付采集插件”。本方案仅保留备查，不执行。采集交付版本已禁用 ERP 同步，并移除 ERP 站点权限。

## 只读检查结果

ERP 位于 C:/Users/Administrator/Desktop/ERP，后端为 Express + SQLite；现有 `/api/douyin-performance` 与 `/sync` 是经纪人团队月度业绩，不是逐主播、逐日数据。ERP 内部主播主键 `anchors.id` 与直播平台主播 ID 不同，现有档案有 `douyinId` 字段。当前 ERP 工作区已有未提交改动，实施时必须保留。

## 申请批准的最小文件范围

1. 修改 `server/app.js`：只增加新模块 import 和登录鉴权之后的路由注册，不改现有月度团队业绩逻辑。
2. 新增 `server/douyin-anchor-daily.js`：实现 GET/POST `/api/integrations/douyin-anchor-daily`，角色校验、事务写入、幂等和审计。
3. 新增 `shared/douyin-anchor-daily.js`：协议、日期与数值校验、主播匹配的纯函数。
4. 新增 `tests/douyin-anchor-daily.test.js`：验证身份与权限、日期范围、重复批次、字段精度、冲突和未匹配主播；仅使用内存测试库。

不修改 ERP 登录、权限矩阵、现有主播档案字段或月度业绩模块；不覆盖任何其他工作区改动。第一阶段只接收并保存数据，ERP 页面增加展示需另行列明范围。

## 接口与鉴权

- GET：要求有效 ERP 登录，返回 `protocol: douyin-anchor-daily/v1`，并告知当前用户是否有同步权限。
- POST：仍用 ERP 现有 HttpOnly `yes_session` Cookie；仅运营负责人或总经理可导入。插件在同一浏览器的 ERP 标签页内发同源请求，保留现有 SameSite、Origin/CSRF 边界，不读取或外传 Cookie，不新增万能密钥。
- 每批最多 100 条；`Idempotency-Key` 为请求内容 SHA-256；接收响应 `accepted` + `unmatched.length` 必须等于批次记录数。对相同幂等键的重试返回同一结果，不重复记账；先校验角色再返回幂等缓存。

## 字段与落库

`date`（上海时区业务日期）、`anchorId`（平台 UID，字符串）、`douyinId`（抖音号，字符串）、`nickname`、`followers`（采集时粉丝快照，非历史粉丝数）、`waves`（该日总音浪）、`liveSeconds`（该日开播总时长，秒）、`acu`（独立 acu 指标，不能用 feed_acu 代替），同时保留原始显示值、采集时间和来源。

- 在现有通用 `records` 中新增独立 kind `douyinAnchorDaily`，以平台 UID + 日期为唯一业务键，不变更表结构。
- 首次按 `anchors.douyinId` 精确匹配 ERP 内部主键，建立单独的绑定记录；之后先按已确认的平台 UID 绑定匹配。昵称不作为自动匹配键。未匹配或匹配冲突留在 `unmatched`，不自动创建或覆盖 ERP 主播档案。
- 缺失、近似指标不写成 0；插件默认阻止这类记录自动同步。重复采集只更新同一主播同一天的数据，不能累计相加。
- 不改工资、提成、结算或历史月报，不自动触发资金流程。

## 验证与发布边界

获得批准后先在干净开发工作区实现和测试，再按 ERP 的 AGENTS.md 流程集成部署；生产发布需备份、核对版本并验证新接口。用户批准前，不修改 ERP、不调用写接口、不部署。

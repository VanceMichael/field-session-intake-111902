# 研学现场资料与学校领件口

所有服务都在本机回环地址运行，数据及组织名称均为合成演练资料。重启来源服务会复位演练资料和当次受理记录。

## 运行

使用 Node.js 22.23.4。
运行 `npm start` 启动演练来源，默认地址为 `http://127.0.0.1:3100`，通过 `PORT` 修改端口。
运行 `npm test` 检查来源服务和原始资料。

`requests/example.json` 是业务人员提交的样例请求。
启动后处于演练阶段 0。可向 `POST /replay/phase` 发送 JSON `{"phase":1}` 切换到下一批资料。阶段切换不会清除此前受理的经办号。

## 来源接口

- `GET /device/manifest` 每包的 interval 是此开机段的闭区间记录序号。pending 表示仪器尚未交包，available 仍需获取原文。
- `GET /device/exports?packet=E-18` 每行一条 JSON。tickMs 为开机后的毫秒。device、boot、sampleNo、channel 共同限定读数身份。
- `GET /device/exports?packet=E-19` 领队离线包和仪器原包的记录号可能重叠。
- `GET /device/exports?packet=E-21` 另一次开机后获取的仪器包。
- `POST /device/receipts` 包领取受理包含 requestKey、packet、boot、records，records 是原包中已收的记录号。
- `GET /device/receipts` 按原经办号核对包领取。
- `GET /device/calibration` UTC 锚点含可能的最大绝对偏移秒数。channelWindow 为厂端允许的开机毫秒区间。
- `GET /locker/transfers` 交接时刻使用 UTC。更正单以 replaces 指向原登记号。
- `GET /station/logbook` stamp 是现场登记，迁移记录只在注明时段及原点位范围生效。replacementPurpose 是场地方补做的许可用途。
- `POST /school/pickups` 学校领件口收 requestKey、group、observations、purpose，撤回另带 priorReceipt。
- `GET /school/pickups` 原领取号查询。

## 收件流程服务

`npm run intake` 启动收件流程，默认 `http://127.0.0.1:3200`。`INTAKE_PORT` 改端口，`SOURCE_ORIGIN` 指来源（默认 `http://127.0.0.1:3100`），`DATA_DIR` 改台账目录（默认 `./data`）。原始记录先保存到 `data/<队次>/packets/`，再向现场确认已收；台账存 `state.json`，重启后恢复。

队次请求即 `requests/example.json` 的形状（visit、day、school、groups[].id/stations，另可带 cancellations 标记取消的站点）。

- `POST /visits` 建队次，正文即队次请求。
- `POST /visits/{队次}/sync` 收件全流程：列出当前导出包 → 保存原始记录 → 按包向现场确认已收 → 厂端标定核查 → 持有窗口与现场印记共同判定归属 → 归属变更撤回旧组并通知接手组 → 按组发放已认定观察。可带 `{"purpose":"课后作业"}`。重复执行不重复受理。
- `POST /visits/{队次}/resolve` 老师裁定：`{"observation":"I4/B12/7/temp","group":"B","note":"…"}`；改派已发观察同样走撤回-通知-重发。
- `POST /visits/{队次}/issue-replacement` 发放场地方补做样本：`{"stamp":"S20","group":"B"}`，另带采集日期与许可用途，不记作学生当天亲采；缺有效读数（退回补录中）时不能发放。
- `GET /visits/{队次}/ledger` 各开机段已覆盖记录号与未上传区间。
- `GET /visits/{队次}/observations` 全部观察及状态（含退回补录的原始记录，仍可追查）。
- `GET /visits/{队次}/venue-report` 场地方缺报。
- `GET /visits/{队次}/pickups` 发放、撤回与通知记录。

判定规则要点：

- 包台账按开机段分别记账，不同开机段的相同记录号互不认账；旧包回传只补自己开机段的缺口。
- 持有窗口只按借还柜台的实际接收与交出确认，更正单（replaces）作废原登记。
- 读数时刻为 开机锚点+tickMs±不确定秒数 的区间；跨交接则对应两组候选。只有持有窗口与现场印记（登记时刻、目击、点位迁移范围）共同指认才认定归属，否则把候选与所缺证据留给老师。
- 缺标定的参数单独退回补录，已有原始记录仍可追查。
- 最终确认完整前区分：站已取消 / 现场已做待取原包 / 原包已收但无有效观察 / 待裁定 / 已确认。
- 采样册迁移记录按 `{migration:{to,since,until}}` 解读，只在注明时段内生效。

# 研学现场资料与学校领件口

所有服务都在本机回环地址运行，数据及组织名称均为合成演练资料。重启来源服务会复位演练资料和当次受理记录。

## 运行

使用 Node.js 22.23.4。
运行 `npm start` 启动演练来源，默认地址为 `http://127.0.0.1:3100`，通过 `PORT` 修改端口。
运行 `npm test` 检查来源服务和原始资料。

`requests/example.json` 是业务人员提交的样例请求。
启动后处于演练阶段 0。可向 `POST /replay/phase` 发送 JSON `{"phase":1}` 切换到下一批资料。阶段切换不会清除此前受理的经办号。

## 来源接口

- `GET /device/exports` 每行一条 JSON。tickMs 为开机后的毫秒。boot、sampleNo、channel 共同限定设备内的读数身份。
- `GET /device/calibration` UTC 锚点含可能的最大绝对偏移秒数。channelWindow 为厂端允许的开机毫秒区间。
- `GET /locker/transfers` 交接时刻使用 UTC。更正单以 replaces 指向原登记号。
- `GET /station/logbook` stamp 是现场登记，迁移记录只在注明时段及原点位范围生效。replacementPurpose 是场地方补做的许可用途。
- `POST /school/pickups` 学校领件口收 requestKey、group、observations、purpose，撤回另带 priorReceipt。
- `GET /school/pickups` 原领取号查询。

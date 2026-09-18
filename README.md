# 海外分行事件联络网

面向跨境金融分行的事件协同服务。统一接收分行告警、人工报告与监管时限，按国家、影响范围和数据敏感度生成事件状态、责任人与沟通任务，替代过去总部、当地技术、公关各自建群导致的等级与口径不一致。

## 运行

```bash
npm start          # PORT（默认 3000）、DATA_DIR（默认 ./data）可用环境变量覆盖
npm test           # node --test，含停机恢复与最终验收场景
```

## 设计要点

- **事件溯源**：所有变更以事件形式追加到 `DATA_DIR/events.jsonl`，重启后回放恢复。停机恢复后未完成的通知与确认继续存在。
- **告警去重**：同一告警指纹重复到达不重复建事件，只记 `alert_duplicate` 并复跑沟通计划；沟通任务按 `(事件, 受众, 类型)` 去重，未确认前不重复推送。
- **分级与责任人**：等级由影响范围 + 数据敏感度计算（SEV1–SEV4）；责任人来自国家联络网值班表；沟通任务按等级与敏感度派发给当地技术、总部、公关与合规。
- **跨时区升级**：L1 分行值班 → L2 区域枢纽 → L3 总部指挥，每次升级记录双方时区与次数。
- **影响范围扩大**：只允许扩大，等级随之重算并补发沟通任务。
- **误报关闭**：`false_alarm` 关闭会注销未完成的沟通任务，全程留痕。
- **附件隔离**：附件带敏感度，按角色（external/pr/branch_tech/hq_command/compliance）隔离，访问无论成败都记审计事件。
- **外发审批**：对外发送只登记申请，经 `hq_command` 或 `compliance` 批准（且审批人不能是申请人）后才产生 `external_sent`。
- **事件合并**：只建立双向关联，双方原始时间线完整保留；被合并事件的告警指纹改指主事件。
- **复盘材料**：`/retrospective` 汇总升级次数、通知去重、时限变更、外发记录与完整时间线。

## API 一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查 |
| GET | `/liaison-network` | 联络网通讯录（国家/区域/总部） |
| POST | `/alerts` | 分行告警（`country/fingerprint/title/impact/sensitivity`，可带 `regulatoryDeadline`） |
| POST | `/incidents` | 人工报告建事件 |
| GET | `/incidents?country=&status=&severity=` | 事件列表 |
| GET | `/incidents/:id` | 事件详情（含通知、附件元信息、外发申请） |
| POST | `/incidents/:id/escalate` | 升级（跨时区，计次数） |
| POST | `/incidents/:id/scope` | 影响范围扩大 |
| POST | `/incidents/:id/deadline` | 监管时限登记/变更（含提前） |
| POST | `/incidents/:id/handover` | 责任人交接 |
| POST | `/incidents/:id/close` | 关闭（`resolved` / `false_alarm`） |
| POST | `/incidents/:id/merge` | 合并（只建关联） |
| GET | `/incidents/:id/timeline` | 完整事件时间线 |
| GET | `/incidents/:id/retrospective` | 复盘材料 |
| POST | `/incidents/:id/attachments` | 上传附件（带敏感度） |
| GET | `/incidents/:id/attachments/:attId` | 读取附件（按 `x-role` 隔离） |
| POST | `/incidents/:id/external-requests` | 外发申请 |
| POST | `/external-requests/:id/decide` | 外发审批（`x-role: hq_command/compliance`） |
| GET | `/notifications?incidentId=&status=` | 沟通任务列表 |
| POST | `/notifications/:id/send` `/ack` | 发送 / 确认 |

请求约定：`x-actor` 标明操作人，`x-role` 标明角色（附件读取与外发审批使用）；枚举取值——影响范围 `branch/country/multi_country/global`，敏感度 `public/internal/confidential/restricted`。

## 目录

- `src/domain.mjs` — 常量与纯函数：分级、联络网、升级路径、去重、reducer、复盘汇总
- `src/store.mjs` — 事件日志存储（追加写 + 回放 + 串行化事务）
- `src/http.mjs` — 路由与命令编排
- `src/server.mjs` — 服务入口
- `test/` — 场景测试（含双分行同时上报、时限提前、交接、停机恢复等验收路径）

敏感配置请放在本地环境文件（`.env` 已在 gitignore 中），运行数据默认写入 `./data`（不入库）。

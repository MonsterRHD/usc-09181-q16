# 海外分行事件联络网

跨境支付中断、监管问询等事件的统一协同服务。总部、当地技术团队、公关部门围绕**同一事件时间线**
协同，而不是各自建群、各自定级、各自口径。

- 接收：分行自动告警与人工报告，携带国家、影响范围、数据敏感度、监管时限
- 产出：事件状态与等级（P1–P4）、责任人、沟通任务（总部上报 / 监管报告等）
- 全程可追溯：重复告警、跨时区升级、范围扩大、时限提前、误报关闭、任务去重、外发拦截均落只增事件
- 隔离：敏感附件按角色密级 + 分行隔离；对外发送必须先经总部/合规批准，且只能携带 public 附件
- 合并：只建立关联（EventLinked），**不抹掉任何原始时间线**
- 恢复：状态全部由只增事件日志重放得到，停机后未完成的通知与确认继续存在

## 运行

```bash
npm start                 # 默认 :3000，事件日志 data/events.jsonl
PORT=4000 npm start
EVENT_LOG=/path/to.jsonl npm start
npm test                  # node:test，含领域与 HTTP 端到端测试
```

## 架构

事件溯源（无第三方依赖）：

```
告警/人工报告 ─┐
              ├─► IncidentService（命令层：规则校验、去重、升级、审批）
HTTP API ──────┘            │  只增事件（JSONL，带 seq 与乐观并发令牌）
                            ▼
                     EventStore (data/events.jsonl)
                            │  重放
                            ▼
                     projection 读模型（事件状态/任务/附件/关联组）
```

- `src/domain/policy.mjs` — 等级矩阵、角色密级、监管机构、任务去重键
- `src/domain/projection.mjs` — 事件流 → 读模型；合并只追加关联
- `src/domain/service.mjs` — 全部业务命令
- `src/store/event-store.mjs` — JSONL 只增日志（另有内存实现供测试）
- `src/http.mjs` / `src/server.mjs` — HTTP 路由与装配

### 等级规则

分数 = 影响范围权重 + 数据敏感度等级；监管时限剩余 ≤ 2 小时再 +1。

| 维度 | 取值（权重/等级） |
| --- | --- |
| 影响范围 | payment_channel 1 · partial_service 2 · branch 3 · multi_branch / customer_wide 4 |
| 数据敏感度 | public 1 · internal 2 · confidential 3 · restricted 4 |

合计 ≥7 P1，≥5 P2，≥3 P3，其余 P4。范围只能扩大（`ScopeExpanded` 留痕），
时限提前（`RegulatorDeadlineMoved.movedEarlier=true`）会立即重算等级。

### 去重与合并

- 同一 `branchCode + sourceAlertId` 重复到达 → `DuplicateAlertReceived`，不重开事件、不重建任务
- 沟通任务有稳定去重键 `channel|audience|subjectKey`；关联组内同键任务未发出则被抑制
  （`NotificationSuppressed`，指向规范任务），新建同键任务记 `NotificationDeduplicated`
- 合并只追加 `EventLinked`：两个事件各自的升级链、交接链、状态史原样保留

### 升级与交接

升级层级 1 分行事件经理 → 2 总部值班（hq-duty）→ 3 高管应急层（exec-duty）。
每次 `EscalationRaised`（含跨时区接力升级）都计数并带时区留痕；`escalationCount`
即升级次数。`OwnerHandover` 保留完整交接链。关联组可一次性整体提前时限 / 交接。

### 附件隔离与外发管控

角色密级：admin/hq/compliance=4，local_tech=3，pr=2；非总部角色另有分行隔离。
外发任务（受众为监管/客户/媒体）须 `approve` 后才能 `send`，附件超出发送人密级或
携带任何非 public 附件都会被拦截并记 `ExternalSendBlocked`。

### 停机恢复

恢复（`IncidentResolved`）只改变事件状态，不级联关闭任务；SENT 未确认、PENDING 未发送的
通知在重放日志后原样还在。最终复盘 `PostmortemFinalized` 固化升级次数、去重清单、
未完成任务、复盘材料引用，且不可重复出具。

## API 摘要

角色经 `x-actor-role`（admin/hq/compliance/local_tech/pr）传入，附件隔离查询再带
`x-branch-code`，升级带 `x-timezone`。

| 方法 路径 | 说明 |
| --- | --- |
| `POST /api/alerts` / `POST /api/reports` | 告警 / 人工报告（重复告警返回 `duplicate:true`） |
| `GET /api/incidents` · `GET /api/incidents/:id` | 列表（可按 country/branchCode 过滤）/ 详情含时间线 |
| `POST /api/incidents/:id/escalations` | 升级（跨时区按头/体记时区，逐次计数） |
| `POST /api/incidents/:id/scope` | 影响范围扩大 |
| `POST /api/incidents/:id/deadline` | 监管时限调整（提前自动提级） |
| `POST /api/incidents/:id/handovers` | 责任人交接 |
| `POST /api/incidents/:id/attachments` | 登记附件（带敏感度） |
| `POST /api/incidents/:id/communications` | 建沟通任务（组内去重） |
| `POST /api/incidents/:id/communications/:taskId/approve|send|confirm` | 批准 / 发送 / 确认 |
| `POST /api/incidents/:id/resolve` · `/false-positive` | 恢复（任务不级联关闭）/ 误报关闭（须填原因） |
| `POST /api/link` | 事件合并（只建关联） |
| `POST /api/groups/:id/deadline` · `/handovers` · `/postmortem` | 组级时限提前 / 交接 / 最终复盘 |
| `GET /api/groups/:id` | 关联组详情 |

请求体示例：

```json
POST /api/alerts
{
  "branchCode": "SG01", "country": "SG", "sourceAlertId": "A-1001",
  "scope": "branch", "sensitivity": "confidential",
  "authorityDeadline": 1789766082921, "title": "新加坡分行支付中断"
}
```

敏感配置（端口、日志路径）通过环境变量提供，不要写入仓库。

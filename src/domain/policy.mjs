// 海外分行事件联络网 —— 领域策略：等级评定、角色密级、监管机构、任务去重键
//
// 设计约束（对应需求中的不变语义）：
//  - 事件状态按「国家 + 影响范围 + 数据敏感度 + 监管时限」计算；
//  - 沟通任务通过稳定去重键在「关联组」内去重，关联（合并）后跨分行也只发一次；
//  - 附件按角色密级隔离，外发渠道只允许 public 附件且必须先审批。

export const SENSITIVITY_LEVELS = Object.freeze({
  public: 1,
  internal: 2,
  confidential: 3,
  restricted: 4,
});

// 影响范围权重：单渠道 < 局部服务 < 单分行 < 多分行/全客户
export const SCOPE_WEIGHTS = Object.freeze({
  payment_channel: 1,
  partial_service: 2,
  branch: 3,
  multi_branch: 4,
  customer_wide: 4,
});

// 角色默认密级：compliance/hq 可见全部；当地技术团队限本分行机密级；公关看不到 restricted
export const ROLE_CLEARANCE = Object.freeze({
  admin: 4,
  hq: 4,
  compliance: 4,
  local_tech: 3,
  pr: 2,
  regulator: 0,
});

// 国家 -> 监管机构
export const AUTHORITIES = Object.freeze({
  SG: 'MAS',
  HK: 'HKMA',
  GB: 'FCA',
  US: 'FRB',
  DE: 'BaFin',
  JP: 'FSA',
});

export function authorityOf(country) {
  return AUTHORITIES[country] || null;
}

// 范围扩大只允许权重单调上升（事件可追溯，不允许悄悄改小）
export function isWiderScope(next, current) {
  return SCOPE_WEIGHTS[next] > SCOPE_WEIGHTS[current];
}

// 事件等级：范围 + 敏感度，监管时限 2 小时内提一级
// P1 >= 7，P2 >= 5，P3 >= 3，其余 P4
export function severityFor({ scope, sensitivity, deadline, now }) {
  const score = SCOPE_WEIGHTS[scope] + SENSITIVITY_LEVELS[sensitivity];
  const tightDeadline = deadline && now && deadline - now.getTime() <= 2 * 60 * 60 * 1000;
  const adjusted = tightDeadline ? score + 1 : score;
  if (adjusted >= 7) return 'P1';
  if (adjusted >= 5) return 'P2';
  if (adjusted >= 3) return 'P3';
  return 'P4';
}

// 升级层级对应的责任人（显式交接可覆盖）
export function tierOwner(level, branchCode) {
  if (level <= 1) return `bm:${branchCode}`; // 分行事件经理
  if (level === 2) return 'hq-duty';         // 总部值班
  return 'exec-duty';                        // 高管应急层
}

export const INTERNAL_ROLES = ['admin', 'hq', 'compliance', 'local_tech', 'pr'];

export function isExternalAudience(audience) {
  return audience.startsWith('regulator:') || audience === 'customers' || audience === 'media';
}

// 沟通任务的稳定去重键：渠道 + 受众 + 主题版本。
// 同一关联组内键相同且任务未作废 -> 记 NotificationDeduplicated，不再建任务。
export function taskDedupKey({ channel, audience, subjectKey }) {
  return `${channel}|${audience}|${subjectKey}`;
}

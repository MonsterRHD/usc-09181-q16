// 领域模型与规则：事件分级、联络网、升级路径、通知去重、附件角色隔离。
// 本文件只包含常量与纯函数，不触碰 IO，方便测试与事件回放。

export const IMPACT_LEVELS = ['branch', 'country', 'multi_country', 'global'];
export const SENSITIVITY_LEVELS = ['public', 'internal', 'confidential', 'restricted'];

// 角色 -> 可访问的数据敏感度上限（按 SENSITIVITY_LEVELS 下标）
export const ROLE_CLEARANCE = {
  external: 0,
  pr: 1,
  branch_tech: 2,
  hq_command: 3,
  compliance: 3,
};

// 可以批准对外发送的角色
export const APPROVER_ROLES = ['hq_command', 'compliance'];

// 海外分行事件联络网：国家/地区 -> 值班联系人与时区
export const LIAISON_NETWORK = {
  SG: {
    name: '新加坡分行', region: 'APAC', tz: 'Asia/Singapore',
    contacts: { commander: 'sg-duty-manager', tech: 'sg-tech-oncall', pr: 'apac-pr-desk', compliance: 'apac-compliance-desk' },
  },
  AE: {
    name: '迪拜分行', region: 'EMEA', tz: 'Asia/Dubai',
    contacts: { commander: 'ae-duty-manager', tech: 'ae-tech-oncall', pr: 'emea-pr-desk', compliance: 'emea-compliance-desk' },
  },
  DE: {
    name: '法兰克福分行', region: 'EMEA', tz: 'Europe/Berlin',
    contacts: { commander: 'de-duty-manager', tech: 'de-tech-oncall', pr: 'emea-pr-desk', compliance: 'emea-compliance-desk' },
  },
  US: {
    name: '纽约分行', region: 'AMER', tz: 'America/New_York',
    contacts: { commander: 'us-duty-manager', tech: 'us-tech-oncall', pr: 'amer-pr-desk', compliance: 'amer-compliance-desk' },
  },
};

export const REGIONAL_HUBS = {
  APAC: { tz: 'Asia/Singapore', contact: 'apac-regional-command' },
  EMEA: { tz: 'Europe/London', contact: 'emea-regional-command' },
  AMER: { tz: 'America/Chicago', contact: 'amer-regional-command' },
};

export const HQ = { tz: 'Asia/Shanghai', command: 'hq-command-center', pr: 'hq-pr-desk', compliance: 'hq-compliance-desk' };

// 事件等级：影响范围为主，敏感度为加权。SEV1 最高。
export function classifySeverity(impact, sensitivity) {
  const impactRank = IMPACT_LEVELS.indexOf(impact);
  const sensRank = SENSITIVITY_LEVELS.indexOf(sensitivity);
  const score = impactRank + (sensRank === 3 ? 2 : sensRank === 2 ? 1 : 0);
  if (score >= 4) return 'SEV1';
  if (score === 3) return 'SEV2';
  if (score === 2) return 'SEV3';
  return 'SEV4';
}

// 按国家、影响范围和数据敏感度生成沟通任务（受众 + 类型）。
// 同一 (事件, 受众, 类型) 的未完成任务会被通知去重拦下，见 ensureNotificationEvents。
export function commPlan(incident) {
  const branch = LIAISON_NETWORK[incident.country];
  const plan = [
    { audience: branch?.contacts.tech ?? 'hq-tech-bridge', kind: 'incident_opened' },
    { audience: HQ.command, kind: 'incident_opened' },
  ];
  if (incident.severity === 'SEV1' || incident.severity === 'SEV2') {
    plan.push({ audience: branch?.contacts.pr ?? HQ.pr, kind: 'incident_opened' });
    plan.push({ audience: HQ.compliance, kind: 'incident_opened' });
  }
  if (SENSITIVITY_LEVELS.indexOf(incident.sensitivity) >= 2) {
    plan.push({ audience: HQ.compliance, kind: 'incident_opened' });
  }
  if (incident.regulatoryDeadline) {
    plan.push({ audience: branch?.contacts.compliance ?? HQ.compliance, kind: 'regulatory_deadline' });
  }
  return plan;
}

// 升级路径：L1 分行值班 -> L2 区域枢纽 -> L3 总部指挥，逐级跨时区。
export function escalationTarget(incident) {
  if (incident.level >= 3) return null;
  const branch = LIAISON_NETWORK[incident.country];
  const hub = REGIONAL_HUBS[branch?.region];
  if (incident.level === 1) return { level: 2, owner: hub?.contact ?? HQ.command, tz: hub?.tz ?? HQ.tz };
  return { level: 3, owner: HQ.command, tz: HQ.tz };
}

export function ownerTimezone(incident) {
  const branch = LIAISON_NETWORK[incident.country];
  if (incident.level === 1) return branch?.tz ?? HQ.tz;
  if (incident.level === 2) return REGIONAL_HUBS[branch?.region]?.tz ?? HQ.tz;
  return HQ.tz;
}

export function canAccess(role, sensitivity) {
  const clearance = ROLE_CLEARANCE[role];
  if (clearance === undefined) return false;
  return clearance >= SENSITIVITY_LEVELS.indexOf(sensitivity);
}

const ID_PREFIX = { incident: 'INC', alert: 'ALT', notification: 'NTF', attachment: 'ATT', externalRequest: 'EXT' };
export const nextId = (state, kind) => `${ID_PREFIX[kind]}-${String(state.counters[kind] + 1).padStart(4, '0')}`;

// 通知去重：同一事件、同一受众、同一类型且仍未确认的任务不重复创建，只记一笔去重痕迹。
export function ensureNotificationEvents(state, incident, audience, kind) {
  const key = `${incident.id}|${audience}|${kind}`;
  const existing = Object.values(state.notifications).find(
    (n) => n.key === key && (n.status === 'pending' || n.status === 'sent'),
  );
  if (existing) {
    return [{ type: 'notification_deduped', incidentId: incident.id, notificationId: existing.id, key, audience, kind }];
  }
  const notification = {
    id: nextId(state, 'notification'),
    incidentId: incident.id,
    audience,
    kind,
    key,
    status: 'pending',
    detail: { title: incident.title, severity: incident.severity, country: incident.country },
    dedupCount: 0,
  };
  return [{ type: 'notification_created', incidentId: incident.id, notification }];
}

export function initialState() {
  return {
    counters: { incident: 0, alert: 0, notification: 0, attachment: 0, externalRequest: 0 },
    incidents: {},
    fingerprints: {}, // 告警指纹 -> 未关闭事件，用于重复告警去重
    notifications: {},
    attachments: {},
    externalRequests: {},
    events: [], // 全量事件，供时间线与复盘
  };
}

function releaseFingerprints(state, incidentId) {
  for (const [fp, ref] of Object.entries(state.fingerprints)) {
    if (ref.incidentId === incidentId) delete state.fingerprints[fp];
  }
}

function repointFingerprints(state, fromIncidentId, toIncidentId) {
  for (const ref of Object.values(state.fingerprints)) {
    if (ref.incidentId === fromIncidentId) ref.incidentId = toIncidentId;
  }
}

// 事件回放：所有状态变更的唯一入口，内存态与磁盘日志共用同一 reducer。
export function reduce(state, event) {
  const inc = event.incidentId ? state.incidents[event.incidentId] : null;
  switch (event.type) {
    case 'incident_created':
      state.incidents[event.incident.id] = { ...event.incident, createdAt: event.ts };
      state.counters.incident += 1;
      break;
    case 'alert_received':
      state.fingerprints[event.fingerprint] = { incidentId: event.incidentId, hits: 1 };
      state.counters.alert += 1;
      break;
    case 'alert_duplicate': {
      const fp = state.fingerprints[event.fingerprint];
      if (fp) fp.hits += 1;
      if (inc) inc.duplicateAlerts += 1;
      break;
    }
    case 'escalated':
      inc.level = event.toLevel;
      inc.assignee = event.toOwner;
      inc.escalationCount += 1;
      break;
    case 'scope_expanded':
      inc.impact = event.to;
      inc.severity = event.severity;
      break;
    case 'deadline_changed':
      inc.regulatoryDeadline = event.to;
      break;
    case 'handover':
      inc.assignee = event.to;
      inc.handoverCount += 1;
      break;
    case 'closed':
      inc.status = event.resolution === 'false_alarm' ? 'closed_false_alarm' : 'closed_resolved';
      inc.closedAt = event.ts;
      inc.closeReason = event.reason;
      releaseFingerprints(state, event.incidentId);
      break;
    case 'merge_linked':
      // 合并只建立关联：被合并事件保留自身时间线，指纹改指主事件。
      if (event.side === 'secondary') {
        inc.mergedInto = event.otherId;
        inc.status = 'merged';
        repointFingerprints(state, event.incidentId, event.otherId);
      } else if (!inc.related.includes(event.otherId)) {
        inc.related.push(event.otherId);
      }
      break;
    case 'notification_created':
      state.notifications[event.notification.id] = { ...event.notification };
      state.counters.notification += 1;
      break;
    case 'notification_deduped': {
      const n = state.notifications[event.notificationId];
      if (n) n.dedupCount += 1;
      break;
    }
    case 'notification_sent':
    case 'notification_acknowledged':
    case 'notification_cancelled': {
      const n = state.notifications[event.notificationId];
      if (!n) break;
      if (event.type === 'notification_sent') { n.status = 'sent'; n.sentAt = event.ts; }
      if (event.type === 'notification_acknowledged') { n.status = 'acknowledged'; n.acknowledgedAt = event.ts; n.acknowledgedBy = event.by ?? null; }
      if (event.type === 'notification_cancelled') { n.status = 'cancelled'; n.cancelledAt = event.ts; n.cancelReason = event.reason ?? null; }
      break;
    }
    case 'attachment_added':
      state.attachments[event.attachment.id] = { ...event.attachment, accessCount: 0, deniedCount: 0 };
      state.counters.attachment += 1;
      break;
    case 'attachment_accessed': {
      const a = state.attachments[event.attachmentId];
      if (a) a.accessCount += 1;
      break;
    }
    case 'attachment_access_denied': {
      const a = state.attachments[event.attachmentId];
      if (a) a.deniedCount += 1;
      break;
    }
    case 'external_request_created':
      state.externalRequests[event.request.id] = { ...event.request };
      state.counters.externalRequest += 1;
      break;
    case 'external_request_approved': {
      const r = state.externalRequests[event.requestId];
      if (r) { r.status = 'approved'; r.approvedBy = event.by; r.approvedAt = event.ts; }
      break;
    }
    case 'external_request_rejected': {
      const r = state.externalRequests[event.requestId];
      if (r) { r.status = 'rejected'; r.decidedBy = event.by; r.decidedAt = event.ts; }
      break;
    }
    case 'external_sent': {
      const r = state.externalRequests[event.requestId];
      if (r) { r.status = 'sent'; r.sentAt = event.ts; }
      break;
    }
    default:
      break;
  }
  state.events.push(event);
  return state;
}

// 复盘材料：从事件时间线汇总，供事后核对升级次数、通知去重与处置过程。
export function buildRetrospective(state, id, now = () => new Date().toISOString()) {
  const inc = state.incidents[id];
  if (!inc) return null;
  const timeline = state.events.filter((e) => e.incidentId === id);
  const notifs = Object.values(state.notifications).filter((n) => n.incidentId === id);
  const byStatus = (s) => notifs.filter((n) => n.status === s).length;
  const requests = Object.values(state.externalRequests).filter((r) => r.incidentId === id);
  return {
    incidentId: id,
    title: inc.title,
    country: inc.country,
    status: inc.status,
    severity: inc.severity,
    generatedAt: now(),
    metrics: {
      alerts: {
        received: timeline.filter((e) => e.type === 'alert_received').length,
        duplicates: timeline.filter((e) => e.type === 'alert_duplicate').length,
      },
      escalationCount: inc.escalationCount,
      crossTimezoneEscalations: timeline.filter((e) => e.type === 'escalated' && e.crossTimezone).length,
      scopeExpansions: timeline.filter((e) => e.type === 'scope_expanded').length,
      handovers: inc.handoverCount,
      deadlineChanges: timeline
        .filter((e) => e.type === 'deadline_changed')
        .map((e) => ({ from: e.from, to: e.to, ts: e.ts, reason: e.reason })),
      notifications: {
        created: notifs.length,
        deduped: notifs.reduce((sum, n) => sum + n.dedupCount, 0),
        pending: byStatus('pending'),
        sent: byStatus('sent'),
        acknowledged: byStatus('acknowledged'),
        cancelled: byStatus('cancelled'),
      },
      external: {
        requested: requests.length,
        approved: requests.filter((r) => r.status === 'approved' || r.status === 'sent').length,
        rejected: requests.filter((r) => r.status === 'rejected').length,
        sent: requests.filter((r) => r.status === 'sent').length,
      },
      falseAlarm: inc.status === 'closed_false_alarm',
    },
    related: inc.related,
    mergedInto: inc.mergedInto,
    timeline,
  };
}

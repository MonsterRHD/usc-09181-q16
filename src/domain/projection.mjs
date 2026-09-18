// 只增事件流 -> 读模型。事件合并不修改任何已记录事件，只产生 EventLinked。
//
// 关联组（mergeGroup）：
//  - 首次 merge 时新建组（primary + related）；同组再次 merge 已组成员为幂等；
//  - 之后可把其它事件并入；组内所有事件共享去重空间与复盘材料；
//  - 每个事件保留各自的原始时间线（statusHistory / escalations / 升级次数）。

import { ROLE_CLEARANCE, severityFor, tierOwner } from './policy.mjs';

function blankIncident(id) {
  return {
    id,
    branchCode: null,
    country: null,
    sourceAlertId: null,
    openedAt: null,
    duplicateOf: null,
    status: 'OPEN', // OPEN | ESCALATED | RESOLVED | FALSE_POSITIVE
    scope: null,
    sensitivity: null,
    authorityDeadline: null,
    severity: null,
    owner: null,
    escalationLevel: 0,
    escalationCount: 0, // 每次 EscalationRaised 都 +1，跨时区重复升级同样计入并留痕
    mergeGroup: null,
    attachments: [],
    tasks: [],
    statusHistory: [],
    notes: [],
    handovers: [],
  };
}

export function project(events, now = Date.now) {
  const incidents = new Map();
  const alertIndex = new Map(); // sourceAlertId+branchCode -> 首次事件
  const groups = new Map();     // groupId -> { id, primary, members:Set, linkedAt, links:[] }
  let seq = 0;

  const get = (id) => {
    if (!incidents.has(id)) incidents.set(id, blankIncident(id));
    return incidents.get(id);
  };

  for (const e of events) {
    seq = e.seq > seq ? e.seq : seq;
    switch (e.type) {
      case 'IncidentOpened': {
        const inc = get(e.incidentId);
        inc.openedAt = e.occurredAt;
        inc.branchCode = e.branchCode;
        inc.country = e.country;
        inc.sourceAlertId = e.sourceAlertId;
        inc.scope = e.scope;
        inc.sensitivity = e.sensitivity;
        inc.authorityDeadline = e.authorityDeadline ?? null;
        inc.severity = severityFor({
          scope: e.scope,
          sensitivity: e.sensitivity,
          deadline: e.authorityDeadline,
          now: new Date(e.occurredAt),
        });
        inc.owner = tierOwner(1, e.branchCode);
        inc.statusHistory.push({ status: 'OPEN', at: e.occurredAt, reason: e.title });
        alertIndex.set(`${e.branchCode}|${e.sourceAlertId}`, e.incidentId);
        break;
      }
      case 'DuplicateAlertReceived': {
        const inc = get(e.incidentId);
        inc.statusHistory.push({ status: inc.status, at: e.occurredAt, reason: `duplicate:${e.sourceAlertId}` });
        break;
      }
      case 'EscalationRaised': {
        const inc = get(e.incidentId);
        inc.escalationCount += 1;
        inc.escalationLevel = e.level;
        inc.owner = e.owner;
        inc.status = 'ESCALATED';
        inc.statusHistory.push({
          status: 'ESCALATED',
          at: e.occurredAt,
          reason: `escalation#${inc.escalationCount} level=${e.level} timezone=${e.timezone}`,
        });
        break;
      }
      case 'ScopeExpanded': {
        const inc = get(e.incidentId);
        inc.scope = e.scope;
        inc.severity = e.newSeverity;
        inc.statusHistory.push({
          status: inc.status,
          at: e.occurredAt,
          reason: `scope=${e.scope} affectedBranches=${e.affectedBranches.join(',')}`,
        });
        break;
      }
      case 'RegulatorDeadlineMoved': {
        const inc = get(e.incidentId);
        inc.authorityDeadline = e.deadline;
        inc.severity = e.newSeverity;
        inc.statusHistory.push({
          status: inc.status,
          at: e.occurredAt,
          reason: `deadline=${e.deadline} movedEarlier=${e.movedEarlier}`,
        });
        break;
      }
      case 'OwnerHandover': {
        const inc = get(e.incidentId);
        inc.owner = e.toOwner;
        inc.handovers.push({ from: e.fromOwner, to: e.toOwner, at: e.occurredAt, reason: e.reason });
        inc.statusHistory.push({ status: inc.status, at: e.occurredAt, reason: `handover:${e.fromOwner}->${e.toOwner}` });
        break;
      }
      case 'IncidentResolved': {
        const inc = get(e.incidentId);
        inc.status = 'RESOLVED';
        inc.resolvedAt = e.occurredAt;
        inc.statusHistory.push({ status: 'RESOLVED', at: e.occurredAt, reason: e.note || '' });
        break;
      }
      case 'FalsePositiveClosed': {
        const inc = get(e.incidentId);
        inc.status = 'FALSE_POSITIVE';
        inc.statusHistory.push({ status: 'FALSE_POSITIVE', at: e.occurredAt, reason: e.reason });
        break;
      }
      case 'AttachmentRegistered': {
        get(e.incidentId).attachments.push({
          id: e.attachmentId,
          name: e.name,
          sensitivity: e.sensitivity,
          uploadedBy: e.actorRole,
          at: e.occurredAt,
        });
        break;
      }
      case 'CommunicationTaskCreated': {
        get(e.incidentId).tasks.push({
          id: e.taskId,
          key: e.dedupKey,
          channel: e.channel,
          audience: e.audience,
          subjectKey: e.subjectKey,
          version: e.version,
          external: e.external,
          status: 'PENDING',
          createdAt: e.occurredAt,
          ownerRole: e.ownerRole,
          approvalId: null,
          completedAt: null,
          confirmedAt: null,
          suppressed: false,
        });
        break;
      }
      case 'NotificationSuppressed': {
        const inc = get(e.incidentId);
        const t = inc.tasks.find((x) => x.id === e.taskId);
        if (t) {
          t.status = 'SUPPRESSED';
          t.suppressed = true;
          t.canonicalTaskId = e.canonicalTaskId;
        }
        inc.statusHistory.push({
          status: inc.status,
          at: e.occurredAt,
          reason: `suppressed dedup ${e.dedupKey} -> ${e.canonicalTaskId}`,
        });
        break;
      }
      case 'NotificationDeduplicated': {
        get(e.incidentId).statusHistory.push({
          status: get(e.incidentId).status,
          at: e.occurredAt,
          reason: `dedup ${e.dedupKey} -> ${e.existingTaskId}`,
        });
        break;
      }
      case 'CommunicationApproved': {
        const t = get(e.incidentId).tasks.find((x) => x.id === e.taskId);
        if (t) {
          t.approvalId = e.approvalId;
          t.approvedBy = e.actorRole;
          t.approvedAt = e.occurredAt;
        }
        break;
      }
      case 'ExternalSendBlocked': {
        get(e.incidentId).statusHistory.push({
          status: get(e.incidentId).status,
          at: e.occurredAt,
          reason: `blocked:${e.reason} task=${e.taskId ?? '-'}`,
        });
        break;
      }
      case 'CommunicationCompleted': {
        const t = get(e.incidentId).tasks.find((x) => x.id === e.taskId);
        if (t) {
          t.status = 'SENT';
          t.completedAt = e.occurredAt;
        }
        break;
      }
      case 'CommunicationConfirmed': {
        const t = get(e.incidentId).tasks.find((x) => x.id === e.taskId);
        if (t) {
          t.status = 'CONFIRMED';
          t.confirmedAt = e.occurredAt;
        }
        break;
      }
      case 'EventLinked': {
        const inc = get(e.incidentId);
        const rel = get(e.relatedIncidentId);
        if (!groups.has(e.groupId)) {
          groups.set(e.groupId, {
            id: e.groupId,
            primary: e.incidentId,
            members: new Set(),
            linkedAt: e.occurredAt,
            links: [],
          });
        }
        const g = groups.get(e.groupId);
        g.members.add(e.incidentId);
        g.members.add(e.relatedIncidentId);
        g.links.push({ a: e.incidentId, b: e.relatedIncidentId, at: e.occurredAt });
        inc.mergeGroup = g.id;
        rel.mergeGroup = g.id;
        break;
      }
      case 'PostmortemFinalized': {
        const g = groups.get(e.groupId);
        if (g) {
          g.postmortem = {
            at: e.occurredAt,
            by: e.actorRole,
            materialRefs: e.materialRefs,
            incidentIds: e.incidentIds,
          };
        }
        break;
      }
      default:
        break;
    }
  }

  // 重放完成后按当前时间重算等级（监管时限提前会直接改变等级；历史上每一版等级已留在 history）
  const nowMs = now();
  for (const inc of incidents.values()) {
    if (inc.status === 'OPEN' || inc.status === 'ESCALATED') {
      inc.severity = severityFor({
        scope: inc.scope,
        sensitivity: inc.sensitivity,
        deadline: inc.authorityDeadline,
        now: new Date(nowMs),
      });
    }
  }

  return {
    incidents,
    groups,
    alertIndex,
    nextSeq: seq + 1,
  };
}

// 角色可见附件：按密级 + 本分行隔离（compliance/admin/hq 不受分行限制）
export function visibleAttachments(incident, role, branchCode) {
  const clearance = ROLE_CLEARANCE[role] ?? 0;
  const crossBranchAllowed = ['admin', 'hq', 'compliance'].includes(role);
  return incident.attachments.filter((a) => {
    const level = { public: 1, internal: 2, confidential: 3, restricted: 4 }[a.sensitivity];
    if (level > clearance) return false;
    if (!crossBranchAllowed && branchCode && incident.branchCode !== branchCode) return false;
    return true;
  });
}

// 关联组内全部待办任务（停机恢复后未完成的通知/确认仍在此处）
export function pendingTasksOfGroup(view, groupId) {
  const g = view.groups.get(groupId);
  if (!g) return [];
  const out = [];
  for (const id of g.members) {
    const inc = view.incidents.get(id);
    if (!inc) continue;
    for (const t of inc.tasks) {
      if (t.status === 'PENDING' || t.status === 'SENT') out.push({ incidentId: id, task: t });
    }
  }
  return out;
}

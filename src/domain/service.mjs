// 命令层：所有业务动作都转成只增事件，一次提交。
// 关键不变式：
//  - 同一告警（分行+告警ID）重复到达：只记 DuplicateAlertReceived，绝不重开事件、不重建任务；
//  - 升级每次都计数并留痕（含跨时区），次数 = EscalationRaised 事件数；
//  - 合并只追加 EventLinked，原始事件与各自时间线一律保留；
//  - 任务在关联组内按稳定键去重，去重本身也落事件（NotificationDeduplicated）；
//  - 外发必须先审批；敏感附件超角色密级 / 对外非 public 一律拦截并留痕；
//  - 停机恢复只靠重放日志，PENDING/SENT 任务原样还在。

import { randomUUID } from 'node:crypto';
import { project } from './projection.mjs';
import {
  AUTHORITIES,
  authorityOf,
  INTERNAL_ROLES,
  isExternalAudience,
  isWiderScope,
  severityFor,
  taskDedupKey,
  tierOwner,
  SCOPE_WEIGHTS,
  SENSITIVITY_LEVELS,
  ROLE_CLEARANCE,
} from './policy.mjs';

export class DomainError extends Error {
  constructor(message, code = 'DOMAIN_RULE') {
    super(message);
    this.name = 'DomainError';
    this.code = code;
  }
}

const APPROVER_ROLES = ['admin', 'hq', 'compliance'];

export class IncidentService {
  constructor(store, { clock = () => Date.now() } = {}) {
    this.store = store;
    this.clock = clock;
  }

  view() {
    return project(this.store.load(), this.clock);
  }

  #commit(build) {
    const history = this.store.load();
    const lastSeq = history.length ? history[history.length - 1].seq : 0;
    const view = project(history, this.clock);
    const events = build(view);
    if (!events || events.length === 0) return [];
    let seq = lastSeq + 1;
    const occurredAt = this.clock();
    const stamped = events.map((e) => ({ seq: seq++, occurredAt, ...e }));
    this.store.append(stamped, lastSeq);
    return stamped;
  }

  #getIncident(view, id) {
    const inc = view.incidents.get(id);
    if (!inc || !inc.openedAt) throw new DomainError(`事件不存在：${id}`, 'NOT_FOUND');
    return inc;
  }

  #groupMemberIds(view, inc) {
    if (!inc.mergeGroup) return [inc.id];
    return [...view.groups.get(inc.mergeGroup).members];
  }

  // —— 告警 / 人工报告 ——

  receiveAlert(input) {
    return this.#open(input, 'alert');
  }

  reportIncident(input) {
    return this.#open({ ...input, sourceAlertId: `manual:${randomUUID()}` }, 'manual');
  }

  #open(input, source) {
    const actorRole = input.actorRole || 'local_tech';
    this.#validateCommon(input);
    const sourceAlertId = input.sourceAlertId;
    if (!sourceAlertId) throw new DomainError('缺少 sourceAlertId');

    let result;
    this.#commit((view) => {
      const existingId = view.alertIndex.get(`${input.branchCode}|${sourceAlertId}`);
      if (existingId) {
        result = { incidentId: existingId, duplicate: true };
        return [{
          type: 'DuplicateAlertReceived',
          incidentId: existingId,
          sourceAlertId,
          branchCode: input.branchCode,
          source,
          timezone: input.timezone || 'UTC',
          actorRole,
        }];
      }

      const incidentId = randomUUID();
      result = { incidentId, duplicate: false };
      const events = [{
        type: 'IncidentOpened',
        incidentId,
        source,
        sourceAlertId,
        branchCode: input.branchCode,
        country: input.country,
        title: input.title || `${input.country} 支付中断`,
        scope: input.scope,
        sensitivity: input.sensitivity,
        authorityDeadline: input.authorityDeadline ?? null,
        timezone: input.timezone || 'UTC',
        actorRole,
      }];

      // 标准沟通任务：总部上报必建；当地有监管机构时建监管报告任务。
      // 合并后再有人按同口径建任务会被组内去重拦截。
      this.#pushDefaultTasks(events, {
        incidentId,
        country: input.country,
        branchCode: input.branchCode,
        actorRole,
      });
      return events;
    });
    return result;
  }

  #pushDefaultTasks(events, { incidentId, country, actorRole }) {
    events.push({
      type: 'CommunicationTaskCreated',
      incidentId,
      taskId: randomUUID(),
      channel: 'phone',
      audience: 'hq-duty',
      subjectKey: 'hq-breach-report',
      dedupKey: taskDedupKey({ channel: 'phone', audience: 'hq-duty', subjectKey: 'hq-breach-report' }),
      version: 1,
      external: false,
      ownerRole: 'local_tech',
      attachmentIds: [],
      actorRole,
    });
    const authority = authorityOf(country);
    if (authority) {
      const subjectKey = 'authority-notification';
      events.push({
        type: 'CommunicationTaskCreated',
        incidentId,
        taskId: randomUUID(),
        channel: 'email',
        audience: `regulator:${authority}`,
        subjectKey,
        dedupKey: taskDedupKey({ channel: 'email', audience: `regulator:${authority}`, subjectKey }),
        version: 1,
        external: true,
        ownerRole: 'compliance',
        attachmentIds: [],
        actorRole,
      });
    }
  }

  #validateCommon(input) {
    if (!input.branchCode) throw new DomainError('缺少 branchCode');
    if (!input.country) throw new DomainError('缺少 country');
    if (!SCOPE_WEIGHTS[input.scope]) throw new DomainError(`非法影响范围：${input.scope}`);
    if (!SENSITIVITY_LEVELS[input.sensitivity]) throw new DomainError(`非法数据敏感度：${input.sensitivity}`);
  }

  // —— 升级（跨时区同样计数） ——

  raiseEscalation({ incidentId, timezone = 'UTC', reason = '', actorRole = 'local_tech', toLevel }) {
    let escalated;
    this.#commit((view) => {
      const inc = this.#getIncident(view, incidentId);
      if (inc.status === 'FALSE_POSITIVE') throw new DomainError('误报已关闭事件不能升级');
      const level = toLevel ?? inc.escalationLevel + 1;
      if (level <= inc.escalationLevel) throw new DomainError(`升级层级只能上升：当前 ${inc.escalationLevel}，请求 ${level}`);
      if (level > 3) throw new DomainError('已达最高升级层级（3=高管应急层）');
      const owner = tierOwner(level, inc.branchCode);
      escalated = { level, owner, escalationCount: inc.escalationCount + 1 };
      return [{
        type: 'EscalationRaised',
        incidentId,
        level,
        owner,
        timezone,
        reason,
        actorRole,
      }];
    });
    return escalated;
  }

  // —— 影响范围扩大 ——

  expandScope({ incidentId, scope, affectedBranches = [], reason = '', actorRole = 'local_tech' }) {
    if (!SCOPE_WEIGHTS[scope]) throw new DomainError(`非法影响范围：${scope}`);
    let out;
    this.#commit((view) => {
      const inc = this.#getIncident(view, incidentId);
      if (!isWiderScope(scope, inc.scope)) throw new DomainError(`影响范围只能扩大：${inc.scope} -> ${scope}`);
      const newSeverity = severityFor({
        scope,
        sensitivity: inc.sensitivity,
        deadline: inc.authorityDeadline,
        now: new Date(this.clock()),
      });
      out = { scope, newSeverity };
      return [{
        type: 'ScopeExpanded',
        incidentId,
        scope,
        affectedBranches,
        newSeverity,
        reason,
        actorRole,
      }];
    });
    return out;
  }

  // —— 监管时限调整（提前必须留痕，并重算等级） ——

  moveDeadline({ incidentId, deadline, reason = '', actorRole = 'compliance' }) {
    return this.#moveDeadlineOne({ incidentId, deadline, reason, actorRole });
  }

  moveGroupDeadline({ groupId, deadline, reason = '', actorRole = 'compliance' }) {
    const results = [];
    this.#commit((view) => {
      const g = view.groups.get(groupId);
      if (!g) throw new DomainError(`关联组不存在：${groupId}`, 'NOT_FOUND');
      const events = [];
      for (const id of g.members) {
        const r = this.#deadlineEvent(view.incidents.get(id), deadline, reason, actorRole);
        results.push(r);
        events.push(r.event);
      }
      return events;
    });
    return results;
  }

  #moveDeadlineOne({ incidentId, deadline, reason, actorRole }) {
    let out;
    this.#commit((view) => {
      const inc = this.#getIncident(view, incidentId);
      const r = this.#deadlineEvent(inc, deadline, reason, actorRole);
      out = { ...r, incidentId };
      return [r.event];
    });
    return out;
  }

  #deadlineEvent(inc, deadline, reason, actorRole) {
    const dl = Number(deadline);
    if (!Number.isFinite(dl)) throw new DomainError('deadline 必须为毫秒时间戳');
    const movedEarlier = inc.authorityDeadline != null && dl < inc.authorityDeadline;
    const newSeverity = severityFor({
      scope: inc.scope,
      sensitivity: inc.sensitivity,
      deadline: dl,
      now: new Date(this.clock()),
    });
    return {
      movedEarlier,
      newSeverity,
      event: {
        type: 'RegulatorDeadlineMoved',
        incidentId: inc.id,
        deadline: dl,
        movedEarlier,
        newSeverity,
        reason,
        actorRole,
      },
    };
  }

  // —— 责任人交接 ——

  handover({ incidentId, toOwner, reason = '', actorRole = 'hq' }) {
    if (!toOwner) throw new DomainError('缺少 toOwner');
    let out;
    this.#commit((view) => {
      const inc = this.#getIncident(view, incidentId);
      out = { fromOwner: inc.owner, toOwner };
      return [{ type: 'OwnerHandover', incidentId, fromOwner: inc.owner, toOwner, reason, actorRole }];
    });
    return out;
  }

  handoverGroup({ groupId, toOwner, reason = '', actorRole = 'hq' }) {
    if (!toOwner) throw new DomainError('缺少 toOwner');
    const out = [];
    this.#commit((view) => {
      const g = view.groups.get(groupId);
      if (!g) throw new DomainError(`关联组不存在：${groupId}`, 'NOT_FOUND');
      const events = [];
      for (const id of g.members) {
        const inc = view.incidents.get(id);
        out.push({ incidentId: id, fromOwner: inc.owner, toOwner });
        events.push({ type: 'OwnerHandover', incidentId: id, fromOwner: inc.owner, toOwner, reason, actorRole });
      }
      return events;
    });
    return out;
  }

  // —— 解决 / 误报关闭（任务不级联关闭，未完成的继续存在） ——

  resolveIncident({ incidentId, note = '', actorRole = 'local_tech' }) {
    this.#commit((view) => {
      const inc = this.#getIncident(view, incidentId);
      if (inc.status === 'FALSE_POSITIVE') throw new DomainError('误报事件不能标记为恢复');
      if (inc.status === 'RESOLVED') return [];
      return [{ type: 'IncidentResolved', incidentId, note, actorRole }];
    });
    return { incidentId, status: 'RESOLVED' };
  }

  closeFalsePositive({ incidentId, reason = '', actorRole = 'local_tech' }) {
    if (!reason) throw new DomainError('误报关闭必须填写原因（可追溯）');
    this.#commit((view) => {
      const inc = this.#getIncident(view, incidentId);
      if (inc.status === 'FALSE_POSITIVE') return [];
      return [{ type: 'FalsePositiveClosed', incidentId, reason, actorRole }];
    });
    return { incidentId, status: 'FALSE_POSITIVE' };
  }

  // —— 合并：只建关联。关联本身不抹时间线；对两事件上尚未发出的同口径任务做去重抑制 ——

  linkIncidents({ incidentId, relatedIncidentId, reason = '', actorRole = 'hq' }) {
    if (incidentId === relatedIncidentId) throw new DomainError('不能关联事件自身');
    let groupId;
    this.#commit((view) => {
      const a = this.#getIncident(view, incidentId);
      const b = this.#getIncident(view, relatedIncidentId);
      if (a.mergeGroup && b.mergeGroup && a.mergeGroup !== b.mergeGroup) {
        throw new DomainError('两个事件分属不同关联组，不支持组间合并');
      }
      if (a.mergeGroup && a.mergeGroup === b.mergeGroup) return []; // 已关联：幂等
      groupId = a.mergeGroup || b.mergeGroup || `G-${randomUUID().slice(0, 8)}`;
      const events = [{
        type: 'EventLinked',
        incidentId,
        relatedIncidentId,
        groupId,
        reason,
        actorRole,
      }];

      // 以发起方事件为主线：同键且双方均未发出的任务，抑制被关联方的副本
      for (const ta of a.tasks) {
        if (ta.status !== 'PENDING') continue;
        const tb = b.tasks.find((x) => x.key === ta.key && x.status === 'PENDING');
        if (tb) {
          events.push({
            type: 'NotificationSuppressed',
            incidentId: relatedIncidentId,
            taskId: tb.id,
            canonicalTaskId: ta.id,
            dedupKey: ta.key,
            reason: `关联到 ${groupId}，与主事件任务去重`,
            actorRole,
          });
        }
      }
      return events;
    });
    return { groupId };
  }

  // —— 附件与角色隔离 ——

  registerAttachment({ incidentId, name, sensitivity, actorRole = 'local_tech' }) {
    if (!name) throw new DomainError('缺少附件名称');
    if (!SENSITIVITY_LEVELS[sensitivity]) throw new DomainError(`非法数据敏感度：${sensitivity}`);
    let attachmentId;
    this.#commit((view) => {
      this.#getIncident(view, incidentId);
      attachmentId = randomUUID();
      return [{ type: 'AttachmentRegistered', incidentId, attachmentId, name, sensitivity, actorRole }];
    });
    return { attachmentId, sensitivity };
  }

  visibleAttachments(incidentId, role, branchCode) {
    const view = this.view();
    const inc = this.#getIncident(view, incidentId);
    const clearance = ROLE_CLEARANCE[role];
    if (clearance == null) throw new DomainError(`未知角色：${role}`);
    const crossBranchAllowed = ['admin', 'hq', 'compliance'].includes(role);
    return inc.attachments.filter((a) => {
      if (SENSITIVITY_LEVELS[a.sensitivity] > clearance) return false;
      if (!crossBranchAllowed && branchCode && inc.branchCode !== branchCode) return false;
      return true;
    });
  }

  // —— 沟通任务：组内去重、审批、外发拦截、确认 ——

  createCommunicationTask(input) {
    const { incidentId, channel, audience, subjectKey, actorRole = 'local_tech', ownerRole, version = 1, attachmentIds = [] } = input;
    if (!channel || !audience || !subjectKey) throw new DomainError('channel/audience/subjectKey 均必填');
    const external = isExternalAudience(audience);
    const dedupKey = taskDedupKey({ channel, audience, subjectKey });
    let result;
    this.#commit((view) => {
      const inc = this.#getIncident(view, incidentId);
      for (const aid of attachmentIds) {
        if (!inc.attachments.some((a) => a.id === aid)) throw new DomainError(`附件不属于该事件：${aid}`);
      }
      const memberIds = this.#groupMemberIds(view, inc);
      for (const mid of memberIds) {
        const sibling = view.incidents.get(mid);
        const hit = sibling.tasks.find((t) => t.key === dedupKey);
        if (hit) {
          result = { deduplicated: true, existingTaskId: hit.id, ownerIncidentId: mid };
          return [{
            type: 'NotificationDeduplicated',
            incidentId,
            existingTaskId: hit.id,
            ownerIncidentId: mid,
            dedupKey,
            actorRole,
          }];
        }
      }
      const taskId = randomUUID();
      result = { deduplicated: false, taskId };
      return [{
        type: 'CommunicationTaskCreated',
        incidentId,
        taskId,
        channel,
        audience,
        subjectKey,
        dedupKey,
        version,
        external,
        ownerRole: ownerRole || (external ? 'compliance' : 'local_tech'),
        attachmentIds,
        actorRole,
      }];
    });
    return result;
  }

  approveCommunication({ incidentId, taskId, actorRole }) {
    if (!APPROVER_ROLES.includes(actorRole)) {
      throw new DomainError('只有总部/合规/管理员可以批准对外沟通', 'UNAUTHORIZED');
    }
    let approvalId;
    this.#commit((view) => {
      const { task } = this.#findTask(view, incidentId, taskId);
      if (!task.external) throw new DomainError('内部沟通无需审批');
      if (task.approvalId) return [];
      approvalId = randomUUID();
      return [{ type: 'CommunicationApproved', incidentId, taskId, approvalId, actorRole }];
    });
    return { approvalId: approvalId ?? null };
  }

  sendCommunication({ incidentId, taskId, actorRole, branchCode, attachmentIds }) {
    let result;
    this.#commit((view) => {
      const inc = this.#getIncident(view, incidentId);
      const { task } = this.#findTask(view, incidentId, taskId);
      if (task.status === 'SENT' || task.status === 'CONFIRMED') {
        result = { blocked: false, alreadyCompleted: true, status: task.status };
        return [];
      }

      const bundleIds = attachmentIds ?? task.attachmentIds ?? [];
      const bundle = bundleIds.map((aid) => {
        const a = inc.attachments.find((x) => x.id === aid);
        if (!a) throw new DomainError(`附件不属于该事件：${aid}`);
        return a;
      });

      // 角色密级隔离：附件超出发送人密级一律拦截
      const clearance = ROLE_CLEARANCE[actorRole] ?? 0;
      const overClearance = bundle.find((a) => SENSITIVITY_LEVELS[a.sensitivity] > clearance);
      if (overClearance) {
        result = { blocked: true, reason: `附件 ${overClearance.name} 密级 ${overClearance.sensitivity} 超出角色 ${actorRole} 权限` };
        return [{ type: 'ExternalSendBlocked', incidentId, taskId, reason: result.reason, actorRole }];
      }

      if (task.external) {
        if (!task.approvalId) {
          result = { blocked: true, reason: '对外发送未经批准' };
          return [{ type: 'ExternalSendBlocked', incidentId, taskId, reason: result.reason, actorRole }];
        }
        const nonPublic = bundle.find((a) => a.sensitivity !== 'public');
        if (nonPublic) {
          result = { blocked: true, reason: `对外渠道禁止携带非公开附件：${nonPublic.name}（${nonPublic.sensitivity}）` };
          return [{ type: 'ExternalSendBlocked', incidentId, taskId, reason: result.reason, actorRole }];
        }
      }

      result = { blocked: false, status: 'SENT' };
      return [{ type: 'CommunicationCompleted', incidentId, taskId, actorRole, branchCode: branchCode ?? null }];
    });
    return result;
  }

  confirmCommunication({ incidentId, taskId, actorRole = 'regulator' }) {
    let result;
    this.#commit((view) => {
      const { task } = this.#findTask(view, incidentId, taskId);
      if (task.status === 'CONFIRMED') {
        result = { alreadyConfirmed: true };
        return [];
      }
      if (task.status !== 'SENT') throw new DomainError('任务尚未发送，不能确认');
      result = { confirmed: true };
      return [{ type: 'CommunicationConfirmed', incidentId, taskId, actorRole }];
    });
    return result;
  }

  #findTask(view, incidentId, taskId) {
    const inc = this.#getIncident(view, incidentId);
    // 允许在组内任一事件入口操作组内任务
    const memberIds = this.#groupMemberIds(view, inc);
    for (const mid of memberIds) {
      const owner = view.incidents.get(mid);
      const task = owner.tasks.find((t) => t.id === taskId);
      if (task) return { task, ownerIncidentId: mid };
    }
    throw new DomainError(`任务不存在：${taskId}`, 'NOT_FOUND');
  }

  // —— 最终复盘：固化升级次数、去重记录、未完成任务、复盘材料 ——

  finalizePostmortem({ groupId, actorRole = 'compliance', materialRefs = [] }) {
    if (!APPROVER_ROLES.includes(actorRole)) throw new DomainError('只有总部/合规/管理员可以最终确认复盘', 'UNAUTHORIZED');
    let snapshot;
    this.#commit((view) => {
      const g = view.groups.get(groupId);
      if (!g) throw new DomainError(`关联组不存在：${groupId}`, 'NOT_FOUND');
      if (g.postmortem) throw new DomainError('复盘已最终确认，不可重复出具（如需补充请新建整改事件）');
      const memberIds = [...g.members];
      const open = memberIds
        .map((id) => view.incidents.get(id))
        .filter((i) => i.status !== 'RESOLVED' && i.status !== 'FALSE_POSITIVE');
      if (open.length) throw new DomainError(`仍有事件未恢复或未定性：${open.map((i) => i.id).join(',')}`);

      const history = this.store.load();
      const dedupEvents = history.filter(
        (e) =>
          (e.type === 'NotificationDeduplicated' || e.type === 'NotificationSuppressed') &&
          memberIds.includes(e.incidentId),
      );
      const incidents = memberIds.map((id) => {
        const i = view.incidents.get(id);
        return {
          incidentId: id,
          branchCode: i.branchCode,
          country: i.country,
          status: i.status,
          escalationCount: i.escalationCount,
          escalations: i.statusHistory
            .filter((h) => h.reason.startsWith('escalation#'))
            .map((h) => ({ at: h.at, reason: h.reason })),
        };
      });
      const tasks = memberIds.flatMap((id) =>
        view.incidents.get(id).tasks.map((t) => ({
          incidentId: id,
          taskId: t.id,
          key: t.key,
          audience: t.audience,
          external: t.external,
          status: t.status,
        })),
      );
      snapshot = {
        incidents,
        totalEscalations: incidents.reduce((n, i) => n + i.escalationCount, 0),
        dedupCount: dedupEvents.length,
        deduplicated: dedupEvents.map((e) => ({
          at: e.occurredAt,
          type: e.type,
          key: e.dedupKey,
          canonicalTaskId: e.existingTaskId || e.canonicalTaskId,
        })),
        tasks,
        outstandingTasks: tasks
          .filter((t) => t.status === 'PENDING' || t.status === 'SENT')
          .map((t) => t.taskId),
        materialRefs,
      };
      return [{
        type: 'PostmortemFinalized',
        groupId,
        incidentIds: memberIds,
        materialRefs,
        snapshot,
        actorRole,
      }];
    });
    return snapshot;
  }
}

export { AUTHORITIES, INTERNAL_ROLES };

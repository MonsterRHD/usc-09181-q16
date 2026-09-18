// HTTP 层：路由、参数校验与命令编排。
// 所有状态变更都通过 store.transact 以事件形式落盘，保证可追溯与停机恢复。
import {
  IMPACT_LEVELS,
  SENSITIVITY_LEVELS,
  LIAISON_NETWORK,
  REGIONAL_HUBS,
  HQ,
  APPROVER_ROLES,
  classifySeverity,
  commPlan,
  escalationTarget,
  ownerTimezone,
  canAccess,
  ensureNotificationEvents,
  buildRetrospective,
  nextId,
} from './domain.mjs';

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
const fail = (status, code, message) => { throw new HttpError(status, code, message); };

function requireFields(body, fields) {
  for (const f of fields) {
    if (body[f] === undefined || body[f] === null || body[f] === '') {
      fail(400, 'missing_field', `缺少必填字段: ${f}`);
    }
  }
}

function validateImpactSensitivity(impact, sensitivity) {
  if (!IMPACT_LEVELS.includes(impact)) fail(400, 'invalid_impact', `影响范围 impact 必须是: ${IMPACT_LEVELS.join(' / ')}`);
  if (!SENSITIVITY_LEVELS.includes(sensitivity)) fail(400, 'invalid_sensitivity', `数据敏感度 sensitivity 必须是: ${SENSITIVITY_LEVELS.join(' / ')}`);
}

function validateCountry(country) {
  if (!LIAISON_NETWORK[country]) fail(400, 'unknown_country', `国家/地区代码不在事件联络网中: ${country}`);
}

function mustIncident(state, id) {
  const inc = state.incidents[id];
  if (!inc) fail(404, 'incident_not_found', `事件不存在: ${id}`);
  return inc;
}

function mustOpen(inc) {
  if (inc.status !== 'open') fail(409, 'invalid_state', `事件 ${inc.id} 当前状态为 ${inc.status}，仅处理中事件可执行该操作`);
}

function buildIncident(state, body, actor, source) {
  const branch = LIAISON_NETWORK[body.country];
  return {
    id: nextId(state, 'incident'),
    title: body.title,
    country: body.country,
    branchId: body.branchId ?? null,
    impact: body.impact,
    sensitivity: body.sensitivity,
    severity: classifySeverity(body.impact, body.sensitivity),
    status: 'open',
    source,
    level: 1,
    assignee: branch?.contacts.commander ?? HQ.command,
    regulatoryDeadline: body.regulatoryDeadline ?? null,
    description: body.description ?? '',
    related: [],
    mergedInto: null,
    escalationCount: 0,
    handoverCount: 0,
    duplicateAlerts: 0,
    createdBy: actor,
  };
}

// 按沟通计划生成通知，重复任务由 ensureNotificationEvents 去重并留痕。
function emitCommPlan(state, emit, incident) {
  for (const item of commPlan(incident)) {
    for (const e of ensureNotificationEvents(state, incident, item.audience, item.kind)) emit(e);
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) {
        reject(new HttpError(413, 'payload_too_large', '请求体过大'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new HttpError(400, 'invalid_json', '请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

export function createApp(store) {
  const routes = buildRoutes(store);
  return async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      for (const [method, pattern, handler] of routes) {
        if (method !== req.method) continue;
        const m = pattern.exec(url.pathname);
        if (!m) continue;
        const body = method === 'GET' ? {} : await readBody(req);
        const ctx = {
          params: m.groups ?? {},
          query: url.searchParams,
          body,
          actor: req.headers['x-actor'] || body.by || 'anonymous',
          role: req.headers['x-role'] || url.searchParams.get('role') || 'external',
        };
        const result = await handler(ctx);
        if (!res.writableEnded) json(res, 200, result ?? { ok: true });
        return;
      }
      json(res, 404, { error: { code: 'not_found', message: '路由不存在' } });
    } catch (e) {
      const status = e.status ?? 500;
      if (status >= 500) console.error(e);
      json(res, status, { error: { code: e.code ?? 'internal_error', message: e.message } });
    }
  };
}

function buildRoutes(store) {
  const openIncident = (state, id) => {
    const inc = mustIncident(state, id);
    mustOpen(inc);
    return inc;
  };

  return [
    ['GET', /^\/health$/, async () => ({ status: 'ok' })],

    ['GET', /^\/$/, async () => ({ service: '海外分行事件联络网', version: 1 })],

    // 联络网通讯录：国家值班联系人、区域枢纽与总部
    ['GET', /^\/liaison-network$/, async () => ({ network: LIAISON_NETWORK, hubs: REGIONAL_HUBS, hq: HQ })],

    // 分行告警：指纹去重，重复到达只留痕并复跑沟通计划（由通知去重拦截）
    ['POST', /^\/alerts$/, async ({ body, actor }) => {
      requireFields(body, ['country', 'fingerprint', 'title', 'impact', 'sensitivity']);
      validateCountry(body.country);
      validateImpactSensitivity(body.impact, body.sensitivity);
      const { result } = await store.transact((state, emit) => {
        const fp = state.fingerprints[body.fingerprint];
        let target = fp ? state.incidents[fp.incidentId] : null;
        while (target?.mergedInto) target = state.incidents[target.mergedInto];
        if (target && target.status === 'open') {
          emit({
            type: 'alert_duplicate', incidentId: target.id, fingerprint: body.fingerprint,
            alert: { country: body.country, branchId: body.branchId ?? null, title: body.title }, by: actor,
          });
          emitCommPlan(state, emit, target);
          return { duplicated: true, incident: target };
        }
        const incident = buildIncident(state, body, actor, 'alert');
        emit({ type: 'incident_created', incidentId: incident.id, incident });
        emit({
          type: 'alert_received', incidentId: incident.id, alertId: nextId(state, 'alert'),
          fingerprint: body.fingerprint, alert: { country: body.country, branchId: body.branchId ?? null, title: body.title }, by: actor,
        });
        emitCommPlan(state, emit, state.incidents[incident.id]);
        return { duplicated: false, incident: state.incidents[incident.id] };
      });
      return result;
    }],

    // 人工报告建事件（可携带监管时限）
    ['POST', /^\/incidents$/, async ({ body, actor }) => {
      requireFields(body, ['country', 'title', 'impact', 'sensitivity']);
      validateCountry(body.country);
      validateImpactSensitivity(body.impact, body.sensitivity);
      if (body.regulatoryDeadline && Number.isNaN(Date.parse(body.regulatoryDeadline))) {
        fail(400, 'invalid_deadline', 'regulatoryDeadline 不是合法时间');
      }
      const { result } = await store.transact((state, emit) => {
        const incident = buildIncident(state, body, actor, 'manual');
        emit({ type: 'incident_created', incidentId: incident.id, incident });
        emitCommPlan(state, emit, state.incidents[incident.id]);
        return { incident: state.incidents[incident.id] };
      });
      return result;
    }],

    ['GET', /^\/incidents$/, async ({ query }) => {
      let list = Object.values(store.state.incidents);
      if (query.get('country')) list = list.filter((i) => i.country === query.get('country'));
      if (query.get('status')) list = list.filter((i) => i.status === query.get('status'));
      if (query.get('severity')) list = list.filter((i) => i.severity === query.get('severity'));
      return { incidents: list };
    }],

    ['GET', /^\/incidents\/(?<id>[^/]+)$/, async ({ params }) => {
      const inc = mustIncident(store.state, params.id);
      const notifications = Object.values(store.state.notifications).filter((n) => n.incidentId === inc.id);
      const attachments = Object.values(store.state.attachments)
        .filter((a) => a.incidentId === inc.id)
        .map(({ content, ...meta }) => meta);
      const externalRequests = Object.values(store.state.externalRequests).filter((r) => r.incidentId === inc.id);
      return { incident: inc, notifications, attachments, externalRequests };
    }],

    // 升级：L1 分行 -> L2 区域枢纽 -> L3 总部，记录跨时区交接
    ['POST', /^\/incidents\/(?<id>[^/]+)\/escalate$/, async ({ params, body, actor }) => {
      const { result } = await store.transact((state, emit) => {
        const inc = openIncident(state, params.id);
        const target = escalationTarget(inc);
        if (!target) fail(409, 'escalation_topped', '事件已升级至总部指挥层，无法继续升级');
        const fromTz = ownerTimezone(inc);
        emit({
          type: 'escalated', incidentId: inc.id,
          fromLevel: inc.level, toLevel: target.level,
          fromOwner: inc.assignee, toOwner: target.owner,
          fromTz, toTz: target.tz, crossTimezone: fromTz !== target.tz,
          reason: body.reason ?? '', by: actor, count: inc.escalationCount + 1,
        });
        const updated = state.incidents[inc.id];
        for (const audience of [target.owner, HQ.command]) {
          for (const e of ensureNotificationEvents(state, updated, audience, 'escalation')) emit(e);
        }
        return { incident: updated };
      });
      return result;
    }],

    // 影响范围扩大（只允许扩大，缩小不属于本流程）
    ['POST', /^\/incidents\/(?<id>[^/]+)\/scope$/, async ({ params, body, actor }) => {
      requireFields(body, ['impact']);
      if (!IMPACT_LEVELS.includes(body.impact)) fail(400, 'invalid_impact', `影响范围 impact 必须是: ${IMPACT_LEVELS.join(' / ')}`);
      const { result } = await store.transact((state, emit) => {
        const inc = openIncident(state, params.id);
        if (IMPACT_LEVELS.indexOf(body.impact) <= IMPACT_LEVELS.indexOf(inc.impact)) {
          fail(409, 'scope_not_expanded', '仅支持影响范围扩大，新范围必须大于当前范围');
        }
        const severity = classifySeverity(body.impact, inc.sensitivity);
        emit({ type: 'scope_expanded', incidentId: inc.id, from: inc.impact, to: body.impact, severity, reason: body.reason ?? '', by: actor });
        const updated = state.incidents[inc.id];
        for (const e of ensureNotificationEvents(state, updated, HQ.command, 'scope_expanded')) emit(e);
        if (severity === 'SEV1' || severity === 'SEV2') {
          const branch = LIAISON_NETWORK[updated.country];
          for (const audience of [branch?.contacts.pr ?? HQ.pr, HQ.compliance]) {
            for (const e of ensureNotificationEvents(state, updated, audience, 'scope_expanded')) emit(e);
          }
        }
        return { incident: updated };
      });
      return result;
    }],

    // 监管时限登记/变更（含提前）
    ['POST', /^\/incidents\/(?<id>[^/]+)\/deadline$/, async ({ params, body, actor }) => {
      requireFields(body, ['deadline']);
      if (Number.isNaN(Date.parse(body.deadline))) fail(400, 'invalid_deadline', 'deadline 不是合法时间');
      const { result } = await store.transact((state, emit) => {
        const inc = openIncident(state, params.id);
        emit({ type: 'deadline_changed', incidentId: inc.id, from: inc.regulatoryDeadline, to: body.deadline, reason: body.reason ?? '', by: actor });
        const updated = state.incidents[inc.id];
        const branch = LIAISON_NETWORK[updated.country];
        for (const e of ensureNotificationEvents(state, updated, branch?.contacts.compliance ?? HQ.compliance, 'deadline_changed')) emit(e);
        return { incident: updated };
      });
      return result;
    }],

    // 责任人交接
    ['POST', /^\/incidents\/(?<id>[^/]+)\/handover$/, async ({ params, body, actor }) => {
      requireFields(body, ['to']);
      const { result } = await store.transact((state, emit) => {
        const inc = openIncident(state, params.id);
        if (body.to === inc.assignee) fail(409, 'handover_to_same', '交接对象与现任责任人相同');
        emit({ type: 'handover', incidentId: inc.id, from: inc.assignee, to: body.to, reason: body.reason ?? '', by: actor });
        const updated = state.incidents[inc.id];
        for (const e of ensureNotificationEvents(state, updated, body.to, 'handover')) emit(e);
        return { incident: updated };
      });
      return result;
    }],

    // 关闭：resolved 或 false_alarm（误报关闭会注销未完成的沟通任务，全程留痕）
    ['POST', /^\/incidents\/(?<id>[^/]+)\/close$/, async ({ params, body, actor }) => {
      requireFields(body, ['resolution']);
      if (!['resolved', 'false_alarm'].includes(body.resolution)) {
        fail(400, 'invalid_resolution', "resolution 必须是 'resolved' 或 'false_alarm'");
      }
      const { result } = await store.transact((state, emit) => {
        const inc = openIncident(state, params.id);
        emit({ type: 'closed', incidentId: inc.id, resolution: body.resolution, reason: body.reason ?? '', by: actor });
        if (body.resolution === 'false_alarm') {
          for (const n of Object.values(state.notifications)) {
            if (n.incidentId === inc.id && (n.status === 'pending' || n.status === 'sent')) {
              emit({ type: 'notification_cancelled', incidentId: inc.id, notificationId: n.id, reason: 'false_alarm' });
            }
          }
        }
        return { incident: state.incidents[inc.id] };
      });
      return result;
    }],

    // 合并：只建立关联，双方时间线完整保留；后续重复告警归并到主事件
    ['POST', /^\/incidents\/(?<id>[^/]+)\/merge$/, async ({ params, body, actor }) => {
      requireFields(body, ['otherId']);
      const { result } = await store.transact((state, emit) => {
        const secondary = openIncident(state, params.id);
        let primary = mustIncident(state, body.otherId);
        while (primary.mergedInto) primary = state.incidents[primary.mergedInto];
        if (secondary.id === primary.id) fail(400, 'merge_self', '不能与自身合并');
        mustOpen(primary);
        emit({ type: 'merge_linked', incidentId: secondary.id, otherId: primary.id, side: 'secondary', reason: body.reason ?? '', by: actor });
        emit({ type: 'merge_linked', incidentId: primary.id, otherId: secondary.id, side: 'primary', reason: body.reason ?? '', by: actor });
        return { primary: state.incidents[primary.id], secondary: state.incidents[secondary.id] };
      });
      return result;
    }],

    ['GET', /^\/incidents\/(?<id>[^/]+)\/timeline$/, async ({ params }) => {
      mustIncident(store.state, params.id);
      return { incidentId: params.id, events: store.state.events.filter((e) => e.incidentId === params.id) };
    }],

    // 复盘材料：升级次数、通知去重、时限变更、外发记录与完整时间线
    ['GET', /^\/incidents\/(?<id>[^/]+)\/retrospective$/, async ({ params }) => {
      const retro = buildRetrospective(store.state, params.id);
      if (!retro) fail(404, 'incident_not_found', `事件不存在: ${params.id}`);
      return retro;
    }],

    // 附件：按敏感度上传，读取按角色隔离，访问无论成败都留痕
    ['POST', /^\/incidents\/(?<id>[^/]+)\/attachments$/, async ({ params, body, actor }) => {
      requireFields(body, ['name', 'sensitivity', 'content']);
      if (!SENSITIVITY_LEVELS.includes(body.sensitivity)) fail(400, 'invalid_sensitivity', `数据敏感度 sensitivity 必须是: ${SENSITIVITY_LEVELS.join(' / ')}`);
      const { result } = await store.transact((state, emit) => {
        openIncident(state, params.id);
        const attachment = {
          id: nextId(state, 'attachment'), incidentId: params.id,
          name: body.name, sensitivity: body.sensitivity, content: String(body.content), uploadedBy: actor,
        };
        emit({ type: 'attachment_added', incidentId: params.id, attachment });
        return { attachment: state.attachments[attachment.id] };
      });
      return result;
    }],

    ['GET', /^\/incidents\/(?<id>[^/]+)\/attachments\/(?<attId>[^/]+)$/, async ({ params, actor, role }) => {
      mustIncident(store.state, params.id);
      const att = Object.values(store.state.attachments).find((a) => a.id === params.attId && a.incidentId === params.id);
      if (!att) fail(404, 'attachment_not_found', `附件不存在: ${params.attId}`);
      if (!canAccess(role, att.sensitivity)) {
        await store.transact((state, emit) => emit({ type: 'attachment_access_denied', incidentId: params.id, attachmentId: att.id, role, by: actor }));
        fail(403, 'attachment_forbidden', `角色 ${role} 无权访问 ${att.sensitivity} 级附件`);
      }
      await store.transact((state, emit) => emit({ type: 'attachment_accessed', incidentId: params.id, attachmentId: att.id, role, by: actor }));
      return { attachment: att };
    }],

    // 外发申请：只登记，不发送；批准后才会产生 external_sent
    ['POST', /^\/incidents\/(?<id>[^/]+)\/external-requests$/, async ({ params, body, actor }) => {
      requireFields(body, ['recipient']);
      if (!body.message && !body.attachmentId) fail(400, 'empty_external', '外发需包含 message 或 attachmentId');
      const { result } = await store.transact((state, emit) => {
        openIncident(state, params.id);
        if (body.attachmentId) {
          const att = Object.values(state.attachments).find((a) => a.id === body.attachmentId && a.incidentId === params.id);
          if (!att) fail(404, 'attachment_not_found', `附件不存在: ${body.attachmentId}`);
        }
        const request = {
          id: nextId(state, 'externalRequest'), incidentId: params.id,
          recipient: body.recipient, message: body.message ?? null, attachmentId: body.attachmentId ?? null,
          requestedBy: actor, status: 'pending_approval',
        };
        emit({ type: 'external_request_created', incidentId: params.id, request });
        return { request: state.externalRequests[request.id] };
      });
      return result;
    }],

    ['GET', /^\/external-requests$/, async ({ query }) => {
      let list = Object.values(store.state.externalRequests);
      if (query.get('incidentId')) list = list.filter((r) => r.incidentId === query.get('incidentId'));
      if (query.get('status')) list = list.filter((r) => r.status === query.get('status'));
      return { externalRequests: list };
    }],

    // 审批：仅 hq_command / compliance，且审批人不能是申请人；批准后记录外发
    ['POST', /^\/external-requests\/(?<id>[^/]+)\/decide$/, async ({ params, body, actor, role }) => {
      requireFields(body, ['decision']);
      if (!['approved', 'rejected'].includes(body.decision)) fail(400, 'invalid_decision', "decision 必须是 'approved' 或 'rejected'");
      if (!APPROVER_ROLES.includes(role)) fail(403, 'approver_role_required', `角色 ${role} 无权审批外发，需 hq_command 或 compliance`);
      const { result } = await store.transact((state, emit) => {
        const req = state.externalRequests[params.id];
        if (!req) fail(404, 'request_not_found', `外发申请不存在: ${params.id}`);
        if (req.status !== 'pending_approval') fail(409, 'already_decided', `外发申请已处理，当前状态: ${req.status}`);
        if (actor === req.requestedBy) fail(403, 'self_approval_forbidden', '审批人不能是申请人本人');
        if (body.decision === 'approved') {
          emit({ type: 'external_request_approved', incidentId: req.incidentId, requestId: req.id, by: actor });
          emit({ type: 'external_sent', incidentId: req.incidentId, requestId: req.id, recipient: req.recipient, attachmentId: req.attachmentId, by: actor });
        } else {
          emit({ type: 'external_request_rejected', incidentId: req.incidentId, requestId: req.id, by: actor });
        }
        return { request: state.externalRequests[req.id] };
      });
      return result;
    }],

    ['GET', /^\/notifications$/, async ({ query }) => {
      let list = Object.values(store.state.notifications);
      if (query.get('incidentId')) list = list.filter((n) => n.incidentId === query.get('incidentId'));
      if (query.get('status')) list = list.filter((n) => n.status === query.get('status'));
      return { notifications: list };
    }],

    ['POST', /^\/notifications\/(?<id>[^/]+)\/send$/, async ({ params, actor }) => {
      const { result } = await store.transact((state, emit) => {
        const n = state.notifications[params.id];
        if (!n) fail(404, 'notification_not_found', `通知不存在: ${params.id}`);
        if (n.status !== 'pending') fail(409, 'invalid_state', `通知当前状态为 ${n.status}，仅 pending 可发送`);
        emit({ type: 'notification_sent', incidentId: n.incidentId, notificationId: n.id, by: actor });
        return { notification: state.notifications[n.id] };
      });
      return result;
    }],

    ['POST', /^\/notifications\/(?<id>[^/]+)\/ack$/, async ({ params, actor }) => {
      const { result } = await store.transact((state, emit) => {
        const n = state.notifications[params.id];
        if (!n) fail(404, 'notification_not_found', `通知不存在: ${params.id}`);
        if (n.status !== 'pending' && n.status !== 'sent') fail(409, 'invalid_state', `通知当前状态为 ${n.status}，无法确认`);
        emit({ type: 'notification_acknowledged', incidentId: n.incidentId, notificationId: n.id, by: actor });
        return { notification: state.notifications[n.id] };
      });
      return result;
    }],
  ];
}

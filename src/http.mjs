// 轻量 HTTP 路由，无第三方依赖。角色通过 x-actor-role 头传入，密级隔离查询再带 x-branch-code。
import { DomainError } from './domain/service.mjs';
import { ConcurrencyError } from './store/event-store.mjs';

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
};

const readBody = (req) =>
  new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 1_000_000) reject(new Error('请求体过大'));
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('非法 JSON'));
      }
    });
    req.on('error', reject);
  });

const actorOf = (req, body = {}) => ({
  actorRole: body.actorRole || req.headers['x-actor-role'] || 'local_tech',
  branchCode: body.branchCode || req.headers['x-branch-code'] || undefined,
  timezone: body.timezone || req.headers['x-timezone'] || 'UTC',
});

const summarize = (inc) => ({
  id: inc.id,
  branchCode: inc.branchCode,
  country: inc.country,
  status: inc.status,
  severity: inc.severity,
  scope: inc.scope,
  sensitivity: inc.sensitivity,
  owner: inc.owner,
  escalationLevel: inc.escalationLevel,
  escalationCount: inc.escalationCount,
  authorityDeadline: inc.authorityDeadline,
  mergeGroup: inc.mergeGroup,
  duplicateOf: inc.duplicateOf,
  openedAt: inc.openedAt,
});

export function createApp(service) {
  return async function app(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    try {
      if (req.method === 'GET' && p === '/health') {
        return json(res, 200, { status: 'ok' });
      }

      if (req.method !== 'POST' && !(req.method === 'GET' && (p.startsWith('/api/incidents/') || p.startsWith('/api/groups/') || p === '/api/incidents'))) {
        return json(res, 404, { error: 'not_found' });
      }

      const body = req.method === 'POST' ? await readBody(req) : {};
      const actor = actorOf(req, body);

      // —— 告警 / 人工报告 ——
      if (p === '/api/alerts' && req.method === 'POST') {
        return json(res, 202, service.receiveAlert({ ...body, ...actor }));
      }
      if (p === '/api/reports' && req.method === 'POST') {
        return json(res, 202, service.reportIncident({ ...body, ...actor }));
      }

      // —— 查询 ——
      if (p === '/api/incidents' && req.method === 'GET') {
        const view = service.view();
        let list = [...view.incidents.values()].filter((i) => i.openedAt);
        const country = url.searchParams.get('country');
        const branchCode = url.searchParams.get('branchCode');
        if (country) list = list.filter((i) => i.country === country);
        if (branchCode) list = list.filter((i) => i.branchCode === branchCode);
        list.sort((a, b) => a.openedAt - b.openedAt);
        return json(res, 200, { incidents: list.map(summarize) });
      }

      let m = p.match(/^\/api\/incidents\/([^/]+)$/);
      if (m && req.method === 'GET') {
        const view = service.view();
        const inc = view.incidents.get(m[1]);
        if (!inc || !inc.openedAt) return json(res, 404, { error: 'not_found' });
        return json(res, 200, {
          ...summarize(inc),
          statusHistory: inc.statusHistory,
          handovers: inc.handovers,
          attachments: service.visibleAttachments(inc.id, actor.actorRole, actor.branchCode),
          tasks: inc.tasks,
        });
      }

      m = p.match(/^\/api\/incidents\/([^/]+)\/(escalations|scope|deadline|handovers|resolve|false-positive|attachments|communications)$/);
      if (m && req.method === 'POST') {
        const [, incidentId, action] = m;
        switch (action) {
          case 'escalations':
            return json(res, 201, service.raiseEscalation({ incidentId, ...body, actorRole: actor.actorRole, timezone: actor.timezone }));
          case 'scope':
            return json(res, 201, service.expandScope({ incidentId, ...body, actorRole: actor.actorRole }));
          case 'deadline':
            return json(res, 201, service.moveDeadline({ incidentId, ...body, actorRole: actor.actorRole }));
          case 'handovers':
            return json(res, 201, service.handover({ incidentId, ...body, actorRole: actor.actorRole }));
          case 'resolve':
            return json(res, 200, service.resolveIncident({ incidentId, ...body, actorRole: actor.actorRole }));
          case 'false-positive':
            return json(res, 200, service.closeFalsePositive({ incidentId, ...body, actorRole: actor.actorRole }));
          case 'attachments':
            return json(res, 201, service.registerAttachment({ incidentId, ...body, actorRole: actor.actorRole }));
          case 'communications':
            return json(res, 201, service.createCommunicationTask({ incidentId, ...body, actorRole: actor.actorRole }));
        }
      }

      m = p.match(/^\/api\/incidents\/([^/]+)\/communications\/([^/]+)\/(approve|send|confirm)$/);
      if (m && req.method === 'POST') {
        const [, incidentId, taskId, action] = m;
        if (action === 'approve') return json(res, 200, service.approveCommunication({ incidentId, taskId, actorRole: actor.actorRole }));
        if (action === 'send') return json(res, 200, service.sendCommunication({ incidentId, taskId, actorRole: actor.actorRole, branchCode: actor.branchCode, attachmentIds: body.attachmentIds }));
        return json(res, 200, service.confirmCommunication({ incidentId, taskId, actorRole: actor.actorRole }));
      }

      if (p === '/api/link' && req.method === 'POST') {
        return json(res, 201, service.linkIncidents({ ...body, actorRole: actor.actorRole }));
      }

      m = p.match(/^\/api\/groups\/([^/]+)\/(deadline|handovers|postmortem)$/);
      if (m && req.method === 'POST') {
        const [, groupId, action] = m;
        if (action === 'deadline') return json(res, 201, service.moveGroupDeadline({ groupId, ...body, actorRole: actor.actorRole }));
        if (action === 'handovers') return json(res, 201, service.handoverGroup({ groupId, ...body, actorRole: actor.actorRole }));
        return json(res, 200, service.finalizePostmortem({ groupId, ...body, actorRole: actor.actorRole }));
      }

      m = p.match(/^\/api\/groups\/([^/]+)$/);
      if (m && req.method === 'GET') {
        const view = service.view();
        const g = view.groups.get(m[1]);
        if (!g) return json(res, 404, { error: 'not_found' });
        return json(res, 200, {
          id: g.id,
          primary: g.primary,
          members: [...g.members],
          links: g.links,
          postmortem: g.postmortem || null,
          incidents: [...g.members].map((id) => summarize(view.incidents.get(id))),
        });
      }

      return json(res, 404, { error: 'not_found' });
    } catch (err) {
      if (err instanceof DomainError) {
        const status = err.code === 'NOT_FOUND' ? 404 : err.code === 'UNAUTHORIZED' ? 403 : 422;
        return json(res, status, { error: err.code, message: err.message });
      }
      if (err instanceof ConcurrencyError) return json(res, 409, { error: 'conflict', message: err.message });
      if (err.message === '非法 JSON' || err.message === '请求体过大') {
        return json(res, 400, { error: 'bad_request', message: err.message });
      }
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'internal', message: err.message }));
    }
  };
}

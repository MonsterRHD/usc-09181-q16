import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { createApp } from '../src/http.mjs';
import { IncidentService } from '../src/domain/service.mjs';
import { MemoryEventStore } from '../src/store/event-store.mjs';

function startServer() {
  const service = new IncidentService(new MemoryEventStore());
  const server = createServer(createApp(service));
  return new Promise((resolve) => {
    server.listen(0, () => {
      const { port } = server.address();
      resolve({
        base: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

async function call(base, method, path, body, headers = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json();
  return { status: res.status, json };
}

test('HTTP 端到端：两分行告警 -> 合并 -> 组时限/交接 -> 外发拦截审批 -> 恢复复盘', async () => {
  const { base, close } = await startServer();
  try {
    const h = await call(base, 'GET', '/health');
    assert.equal(h.json.status, 'ok');

    const deadline = Date.now() + 5 * 3600_000;
    const a = await call(base, 'POST', '/api/alerts', {
      branchCode: 'SG01', country: 'SG', sourceAlertId: 'A-1',
      scope: 'branch', sensitivity: 'confidential', authorityDeadline: deadline,
    }, { 'x-actor-role': 'local_tech', 'x-timezone': 'Asia/Singapore' });
    assert.equal(a.status, 202);

    // 重复告警
    const dup = await call(base, 'POST', '/api/alerts', {
      branchCode: 'SG01', country: 'SG', sourceAlertId: 'A-1',
      scope: 'branch', sensitivity: 'confidential',
    });
    assert.equal(dup.json.duplicate, true);
    assert.equal(dup.json.incidentId, a.json.incidentId);

    const b = await call(base, 'POST', '/api/alerts', {
      branchCode: 'HK01', country: 'HK', sourceAlertId: 'B-2',
      scope: 'branch', sensitivity: 'confidential', authorityDeadline: deadline + 3600_000,
    }, { 'x-timezone': 'Asia/Hong_Kong' });

    await call(base, 'POST', `/api/incidents/${a.json.incidentId}/escalations`, { reason: 'r1' }, { 'x-timezone': 'Asia/Singapore' });
    await call(base, 'POST', `/api/incidents/${a.json.incidentId}/escalations`, { reason: 'r2' }, { 'x-timezone': 'Europe/London' });
    await call(base, 'POST', `/api/incidents/${b.json.incidentId}/escalations`, { reason: 'r3' }, { 'x-timezone': 'Asia/Hong_Kong' });

    const link = await call(base, 'POST', '/api/link', {
      incidentId: a.json.incidentId, relatedIncidentId: b.json.incidentId, reason: '同一清算故障',
    }, { 'x-actor-role': 'hq' });
    const groupId = link.json.groupId;

    const earlier = Date.now() + 45 * 60_000;
    const moved = await call(base, 'POST', `/api/groups/${groupId}/deadline`, { deadline: earlier, reason: '联合问询' }, { 'x-actor-role': 'compliance' });
    assert.equal(moved.status, 201);
    assert.ok(moved.json.every((r) => r.movedEarlier && r.newSeverity === 'P1'));

    const ho = await call(base, 'POST', `/api/groups/${groupId}/handovers`, { toOwner: 'exec-duty' }, { 'x-actor-role': 'hq' });
    assert.equal(ho.json.length, 2);

    // 附件：public + restricted
    const pub = await call(base, 'POST', `/api/incidents/${a.json.incidentId}/attachments`, { name: '声明.pdf', sensitivity: 'public' });
    const secret = await call(base, 'POST', `/api/incidents/${a.json.incidentId}/attachments`, { name: '数据.xlsx', sensitivity: 'restricted' });

    // 公关视角只见 public 附件
    const asPr = await call(base, 'GET', `/api/incidents/${a.json.incidentId}`, undefined, { 'x-actor-role': 'pr', 'x-branch-code': 'SG01' });
    assert.equal(asPr.json.attachments.length, 1);

    // 找 MAS 监管任务
    const detail = await call(base, 'GET', `/api/incidents/${a.json.incidentId}`);
    const masTask = detail.json.tasks.find((t) => t.audience === 'regulator:MAS');

    // 未审批外发 -> 422 语义体现在 blocked
    const blocked1 = await call(base, 'POST', `/api/incidents/${a.json.incidentId}/communications/${masTask.id}/send`, {}, { 'x-actor-role': 'compliance' });
    assert.equal(blocked1.json.blocked, true);

    // 公关审批 -> 403
    const denied = await call(base, 'POST', `/api/incidents/${a.json.incidentId}/communications/${masTask.id}/approve`, {}, { 'x-actor-role': 'pr' });
    assert.equal(denied.status, 403);

    // 合规批准
    await call(base, 'POST', `/api/incidents/${a.json.incidentId}/communications/${masTask.id}/approve`, {}, { 'x-actor-role': 'compliance' });

    // 携带 restricted -> 拦截
    const blocked2 = await call(base, 'POST', `/api/incidents/${a.json.incidentId}/communications/${masTask.id}/send`, { attachmentIds: [pub.json.attachmentId, secret.json.attachmentId] }, { 'x-actor-role': 'compliance' });
    assert.equal(blocked2.json.blocked, true);

    // 仅 public -> 发送 + 确认
    const sent = await call(base, 'POST', `/api/incidents/${a.json.incidentId}/communications/${masTask.id}/send`, { attachmentIds: [pub.json.attachmentId] }, { 'x-actor-role': 'compliance' });
    assert.equal(sent.json.blocked, false);
    await call(base, 'POST', `/api/incidents/${a.json.incidentId}/communications/${masTask.id}/confirm`, {});

    // 同口径重复建任务被去重
    const dedup = await call(base, 'POST', `/api/incidents/${b.json.incidentId}/communications`, {
      channel: 'email', audience: 'regulator:MAS', subjectKey: 'authority-notification',
    });
    assert.equal(dedup.json.deduplicated, true);

    // 误报关闭缺原因 -> 422；恢复两事件
    const badFp = await call(base, 'POST', `/api/incidents/${a.json.incidentId}/false-positive`, {});
    assert.equal(badFp.status, 422);

    // 组内存在 PENDING 任务不影响恢复
    await call(base, 'POST', `/api/incidents/${a.json.incidentId}/resolve`, { note: '恢复' });
    await call(base, 'POST', `/api/incidents/${b.json.incidentId}/resolve`, { note: '恢复' });

    const pm = await call(base, 'POST', `/api/groups/${groupId}/postmortem`, { materialRefs: ['doc://rca'] }, { 'x-actor-role': 'compliance' });
    assert.equal(pm.status, 200);
    assert.equal(pm.json.totalEscalations, 3);
    assert.ok(pm.json.dedupCount >= 2); // 抑制 1 + 去重 1
    assert.ok(pm.json.outstandingTasks.length >= 1);
    assert.deepEqual(pm.json.materialRefs, ['doc://rca']);

    // 查询接口
    const list = await call(base, 'GET', '/api/incidents?country=SG');
    assert.equal(list.json.incidents.length, 1);
    const g = await call(base, 'GET', `/api/groups/${groupId}`);
    assert.equal(g.json.members.length, 2);
  } finally {
    await close();
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { IncidentService, DomainError } from '../src/domain/service.mjs';
import { MemoryEventStore, EventStore } from '../src/store/event-store.mjs';
import { severityFor } from '../src/domain/policy.mjs';

const svc = () => new IncidentService(new MemoryEventStore(), { clock: () => T0 });
const T0 = Date.parse('2026-09-18T08:00:00Z');
const MIN = 60_000;

function openSG(service, overrides = {}) {
  return service.receiveAlert({
    branchCode: 'SG01',
    country: 'SG',
    sourceAlertId: 'A-1001',
    scope: 'branch',
    sensitivity: 'confidential',
    authorityDeadline: T0 + 4 * 60 * MIN,
    timezone: 'Asia/Singapore',
    title: '新加坡分行支付中断',
    ...overrides,
  });
}

test('等级评定：范围+敏感度定级，监管时限 2 小时内提一级', () => {
  const base = { scope: 'branch', sensitivity: 'internal', deadline: T0 + 4 * 60 * MIN, now: new Date(T0) };
  assert.equal(severityFor(base), 'P2'); // 3+2=5
  assert.equal(severityFor({ ...base, sensitivity: 'confidential' }), 'P2'); // 3+3=6
  const tight = severityFor({ scope: 'branch', sensitivity: 'confidential', deadline: T0 + 90 * MIN, now: new Date(T0) });
  assert.equal(tight, 'P1'); // 6+1=7
  assert.equal(severityFor({ scope: 'payment_channel', sensitivity: 'public', deadline: null, now: new Date(T0) }), 'P4'); // 1+1=2
  assert.equal(severityFor({ scope: 'multi_branch', sensitivity: 'restricted', deadline: null, now: new Date(T0) }), 'P1');
});

test('同一告警重复到达：只记留痕，不重开事件、不重建任务', () => {
  const s = svc();
  const first = openSG(s);
  assert.equal(first.duplicate, false);
  const again = openSG(s);
  assert.equal(again.duplicate, true);
  assert.equal(again.incidentId, first.incidentId);

  const inc = s.view().incidents.get(first.incidentId);
  assert.equal(inc.tasks.length, 2); // 总部上报 + MAS 监管报告
  const dup = s.store.load().filter((e) => e.type === 'DuplicateAlertReceived');
  assert.equal(dup.length, 1);
  assert.equal(dup[0].sourceAlertId, 'A-1001');
});

test('跨时区升级每次计数留痕，责任人随层级变化', () => {
  const s = svc();
  const { incidentId } = openSG(s);
  s.raiseEscalation({ incidentId, timezone: 'Asia/Singapore', reason: '分行 30 分钟未恢复' });
  s.raiseEscalation({ incidentId, timezone: 'Europe/London', reason: '伦敦总部值班接力升级' });
  const inc = s.view().incidents.get(incidentId);
  assert.equal(inc.escalationCount, 2);
  assert.equal(inc.escalationLevel, 2);
  assert.equal(inc.owner, 'hq-duty');
  assert.deepEqual(
    inc.statusHistory.filter((h) => h.reason.startsWith('escalation#')).map((h) => h.reason),
    ['escalation#1 level=1 timezone=Asia/Singapore', 'escalation#2 level=2 timezone=Europe/London'],
  );
});

test('影响范围只能扩大，扩大后等级重算并留痕', () => {
  const s = svc();
  const { incidentId } = openSG(s);
  const r = s.expandScope({ incidentId, scope: 'multi_branch', affectedBranches: ['SG01', 'HK01'] });
  assert.equal(r.newSeverity, 'P1'); // 4+3=7
  assert.throws(() => s.expandScope({ incidentId, scope: 'partial_service' }), DomainError);
});

test('监管时限提前：留痕 movedEarlier 并提升等级', () => {
  const s = svc();
  const { incidentId } = openSG(s, { authorityDeadline: T0 + 4 * 60 * MIN });
  const r = s.moveDeadline({ incidentId, deadline: T0 + 60 * MIN, reason: 'MAS 提前问询' });
  assert.equal(r.movedEarlier, true);
  assert.equal(r.newSeverity, 'P1');
  const hist = s.view().incidents.get(incidentId).statusHistory;
  assert.ok(hist.some((h) => h.reason.includes('movedEarlier=true')));
});

test('责任人交接保留交接链', () => {
  const s = svc();
  const { incidentId } = openSG(s);
  const r = s.handover({ incidentId, toOwner: 'bm:HK02', reason: '跨时区交班' });
  assert.equal(r.fromOwner, 'bm:SG01');
  const inc = s.view().incidents.get(incidentId);
  assert.equal(inc.owner, 'bm:HK02');
  assert.equal(inc.handovers.length, 1);
});

test('误报关闭必须有原因且可追溯，之后不能升级', () => {
  const s = svc();
  const { incidentId } = openSG(s);
  assert.throws(() => s.closeFalsePositive({ incidentId }), DomainError);
  s.closeFalsePositive({ incidentId, reason: '监控规则错误，交易实际成功' });
  assert.equal(s.view().incidents.get(incidentId).status, 'FALSE_POSITIVE');
  assert.throws(() => s.raiseEscalation({ incidentId }), DomainError);
});

test('附件按角色密级和分行隔离', () => {
  const s = svc();
  const { incidentId } = openSG(s);
  const a1 = s.registerAttachment({ incidentId, name: '对外声明稿.pdf', sensitivity: 'public' });
  s.registerAttachment({ incidentId, name: '客户数据清单.xlsx', sensitivity: 'restricted' });
  s.registerAttachment({ incidentId, name: '内部拓扑.png', sensitivity: 'confidential' });

  assert.equal(s.visibleAttachments(incidentId, 'pr', 'SG01').length, 1); // 只见 public
  assert.equal(s.visibleAttachments(incidentId, 'local_tech', 'SG01').length, 2); // public+confidential
  assert.equal(s.visibleAttachments(incidentId, 'local_tech', 'HK01').length, 0); // 跨分行隔离
  assert.equal(s.visibleAttachments(incidentId, 'hq').length, 3);
  assert.equal(s.visibleAttachments(incidentId, 'pr', 'SG01')[0].id, a1.attachmentId);
});

test('对外通知：未批准拦截、非公开附件拦截、批准且仅 public 可发送并确认', () => {
  const s = svc();
  const { incidentId } = openSG(s);
  const inc = () => s.view().incidents.get(incidentId);
  const taskId = inc().tasks.find((t) => t.audience === 'regulator:MAS').id;
  const pub = s.registerAttachment({ incidentId, name: '声明.pdf', sensitivity: 'public' }).attachmentId;
  const secret = s.registerAttachment({ incidentId, name: '数据.xlsx', sensitivity: 'restricted' }).attachmentId;

  // 未批准先发送 -> 拦截留痕
  let r = s.sendCommunication({ incidentId, taskId, actorRole: 'compliance' });
  assert.equal(r.blocked, true);
  assert.match(r.reason, /未经批准/);

  // 公关无权审批
  assert.throws(() => s.approveCommunication({ incidentId, taskId, actorRole: 'pr' }), DomainError);

  // 合规批准
  s.approveCommunication({ incidentId, taskId, actorRole: 'compliance' });

  // 携带 restricted 附件发送 -> 拦截
  r = s.sendCommunication({ incidentId, taskId, actorRole: 'compliance', attachmentIds: [pub, secret] });
  assert.equal(r.blocked, true);
  assert.match(r.reason, /非公开附件/);

  // 只带 public -> 发送成功 -> 监管确认
  r = s.sendCommunication({ incidentId, taskId, actorRole: 'compliance', attachmentIds: [pub] });
  assert.equal(r.blocked, false);
  s.confirmCommunication({ incidentId, taskId, actorRole: 'regulator:MAS' });
  assert.equal(inc().tasks.find((t) => t.id === taskId).status, 'CONFIRMED');

  const blocked = s.store.load().filter((e) => e.type === 'ExternalSendBlocked');
  assert.equal(blocked.length, 2);
});

test('事件合并只建关联：原始时间线保留，同口径通知去重抑制', () => {
  const s = svc();
  const sg = openSG(s);
  const hk = s.receiveAlert({
    branchCode: 'HK01',
    country: 'HK',
    sourceAlertId: 'A-2002',
    scope: 'branch',
    sensitivity: 'confidential',
    authorityDeadline: T0 + 3 * 60 * MIN,
    timezone: 'Asia/Hong_Kong',
  });

  const { groupId } = s.linkIncidents({
    incidentId: sg.incidentId,
    relatedIncidentId: hk.incidentId,
    reason: '同一跨境清算网络故障',
  });
  const view = s.view();
  assert.equal(view.groups.get(groupId).members.size, 2);

  // 两个事件各自原始时间线不动
  const sgInc = view.incidents.get(sg.incidentId);
  const hkInc = view.incidents.get(hk.incidentId);
  assert.equal(sgInc.mergeGroup, groupId);
  assert.equal(hkInc.mergeGroup, groupId);
  assert.ok(sgInc.statusHistory.some((h) => h.status === 'OPEN'));
  assert.ok(hkInc.statusHistory.some((h) => h.status === 'OPEN'));

  // HK 的总部上报任务（同渠道同受众同主题，且未发出）被抑制，指向 SG 的规范任务
  const sgHqTask = sgInc.tasks.find((t) => t.audience === 'hq-duty');
  const hkHqTask = hkInc.tasks.find((t) => t.audience === 'hq-duty');
  assert.equal(sgHqTask.status, 'PENDING');
  assert.equal(hkHqTask.status, 'SUPPRESSED');
  assert.equal(hkHqTask.canonicalTaskId, sgHqTask.id);

  // 再次关联为幂等
  s.linkIncidents({ incidentId: sg.incidentId, relatedIncidentId: hk.incidentId });
  assert.equal(s.store.load().filter((e) => e.type === 'EventLinked').length, 1);

  // 合并后再建同口径任务 -> NotificationDeduplicated
  const d = s.createCommunicationTask({
    incidentId: hk.incidentId,
    channel: 'phone',
    audience: 'hq-duty',
    subjectKey: 'hq-breach-report',
  });
  assert.equal(d.deduplicated, true);
  assert.equal(d.existingTaskId, sgHqTask.id);
});

test('关联组监管时限提前与责任人交接同时覆盖两个分行', () => {
  const s = svc();
  const sg = openSG(s);
  const hk = s.receiveAlert({
    branchCode: 'HK01', country: 'HK', sourceAlertId: 'A-2002',
    scope: 'branch', sensitivity: 'confidential', authorityDeadline: T0 + 3 * 60 * MIN,
  });
  const { groupId } = s.linkIncidents({ incidentId: sg.incidentId, relatedIncidentId: hk.incidentId });
  const results = s.moveGroupDeadline({ groupId, deadline: T0 + 45 * MIN, reason: '两地监管联合提前问询' });
  assert.equal(results.length, 2);
  assert.ok(results.every((r) => r.movedEarlier && r.newSeverity === 'P1'));
  const ho = s.handoverGroup({ groupId, toOwner: 'exec-duty', reason: '升级至高管应急层' });
  assert.equal(ho.length, 2);
  const view = s.view();
  assert.ok([...view.groups.get(groupId).members].every((id) => view.incidents.get(id).owner === 'exec-duty'));
});

test('停机恢复：事件日志重放后未完成通知/确认继续存在', () => {
  const dir = mkdtempSync(join(tmpdir(), 'branchnet-'));
  try {
    const file = join(dir, 'events.jsonl');
    const s1 = new IncidentService(new EventStore(file), { clock: () => T0 });
    const { incidentId } = openSG(s1);
    s1.raiseEscalation({ incidentId, timezone: 'Asia/Singapore' });
    const taskId = s1.view().incidents.get(incidentId).tasks.find((t) => t.external).id;
    s1.approveCommunication({ incidentId, taskId, actorRole: 'compliance' });
    s1.sendCommunication({ incidentId, taskId, actorRole: 'compliance' }); // SENT 但尚未 CONFIRMED
    // 模拟停机：直接换新服务实例，从日志重放
    const s2 = new IncidentService(new EventStore(file), { clock: () => T0 + 30 * MIN });
    const inc = s2.view().incidents.get(incidentId);
    assert.equal(inc.escalationCount, 1);
    const t = inc.tasks.find((x) => x.id === taskId);
    assert.equal(t.status, 'SENT'); // 未完成的确认仍在
    s2.confirmCommunication({ incidentId, taskId });
    assert.equal(s2.view().incidents.get(incidentId).tasks.find((x) => x.id === taskId).status, 'CONFIRMED');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('最终复盘：两个分行同时上报、时限提前、责任人交接后核对升级次数/去重/材料/未完成项', () => {
  const s = svc();
  // 两个分行同时上报同一根因
  const sg = openSG(s);
  const hk = s.receiveAlert({
    branchCode: 'HK01', country: 'HK', sourceAlertId: 'A-2002',
    scope: 'branch', sensitivity: 'confidential', authorityDeadline: T0 + 3 * 60 * MIN,
    timezone: 'Asia/Hong_Kong',
  });
  // SG 跨两个时区升级两次；HK 升级一次
  s.raiseEscalation({ incidentId: sg.incidentId, timezone: 'Asia/Singapore' });
  s.raiseEscalation({ incidentId: sg.incidentId, timezone: 'Europe/London' });
  s.raiseEscalation({ incidentId: hk.incidentId, timezone: 'Asia/Hong_Kong' });

  // 合并（HK 同口径总部上报任务被抑制）
  const { groupId } = s.linkIncidents({ incidentId: sg.incidentId, relatedIncidentId: hk.incidentId, reason: '同一清算网关故障' });

  // 监管时限提前
  s.moveGroupDeadline({ groupId, deadline: T0 + 45 * MIN, reason: '监管提前问询' });
  // 责任人交接
  s.handoverGroup({ groupId, toOwner: 'exec-duty', reason: '高管层接管' });

  // 未全部恢复时不能复盘
  assert.throws(
    () => s.finalizePostmortem({ groupId, actorRole: 'compliance', materialRefs: ['doc://rca'] }),
    DomainError,
  );

  // 完成并确认 SG 总部上报任务；HK 的监管报告任务保持 PENDING（模拟通知未完成）
  const sgInc = s.view().incidents.get(sg.incidentId);
  const hqTask = sgInc.tasks.find((t) => t.audience === 'hq-duty');
  s.sendCommunication({ incidentId: sg.incidentId, taskId: hqTask.id, actorRole: 'hq' });
  s.confirmCommunication({ incidentId: sg.incidentId, taskId: hqTask.id, actorRole: 'hq-duty' });

  s.resolveIncident({ incidentId: sg.incidentId, note: '流量切回主数据中心' });
  s.resolveIncident({ incidentId: hk.incidentId, note: '旁路恢复' });

  const rca = s.finalizePostmortem({
    groupId,
    actorRole: 'compliance',
    materialRefs: ['doc://timeline', 'doc://rca', 'doc://regulator-log'],
  });

  assert.equal(rca.totalEscalations, 3); // 2 + 1，跨时区升级如实计入
  assert.deepEqual(rca.incidents.map((i) => i.escalationCount).sort(), [1, 2]);
  assert.ok(rca.dedupCount >= 1); // 合并时抑制的 HK 总部上报
  assert.ok(rca.deduplicated.some((d) => d.type === 'NotificationSuppressed' && d.key.endsWith('hq-duty|hq-breach-report')));
  assert.deepEqual(rca.materialRefs, ['doc://timeline', 'doc://rca', 'doc://regulator-log']);
  // 未完成通知在复盘材料中显式列出，不随停机恢复消失
  assert.ok(rca.outstandingTasks.length >= 1);
  const hkPending = s.view().incidents.get(hk.incidentId).tasks.filter((t) => t.status === 'PENDING');
  for (const t of hkPending) assert.ok(rca.outstandingTasks.includes(t.id));

  // 复盘不可重复出具
  assert.throws(() => s.finalizePostmortem({ groupId, actorRole: 'compliance' }), DomainError);
  // 原始事件时间线仍可独立追溯
  const view = s.view();
  for (const id of [sg.incidentId, hk.incidentId]) {
    const inc = view.incidents.get(id);
    assert.equal(inc.status, 'RESOLVED');
    assert.ok(inc.statusHistory.some((h) => h.reason.startsWith('escalation#')));
    assert.ok(inc.statusHistory.some((h) => h.reason.startsWith('handover:')));
  }
});

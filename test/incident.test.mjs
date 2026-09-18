import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer, api, tempDir } from './helpers.mjs';

const SG_ALERT = {
  country: 'SG', branchId: 'SG-001', fingerprint: 'sg-pay-switch-down',
  title: '支付交换机中断', impact: 'country', sensitivity: 'confidential',
};

async function fresh() {
  return startServer(await tempDir());
}

test('告警建事件：按国家/影响范围/敏感度生成状态、责任人与沟通任务', async () => {
  const { base, close } = await fresh();
  try {
    const res = await api(base, 'POST', '/alerts', { body: SG_ALERT, actor: 'sg-monitor' });
    assert.equal(res.status, 200);
    const inc = res.data.incident;
    assert.equal(inc.status, 'open');
    assert.equal(inc.assignee, 'sg-duty-manager'); // 责任人来自国家联络网
    assert.equal(inc.severity, 'SEV3'); // country + confidential
    assert.equal(inc.level, 1);

    const notifs = (await api(base, 'GET', `/notifications?incidentId=${inc.id}`)).data.notifications;
    const keys = notifs.map((n) => `${n.audience}:${n.kind}`);
    assert.ok(keys.includes('sg-tech-oncall:incident_opened'));
    assert.ok(keys.includes('hq-command-center:incident_opened'));
    assert.ok(keys.includes('hq-compliance-desk:incident_opened')); // confidential 触发合规
    assert.ok(notifs.every((n) => n.status === 'pending'));
  } finally {
    await close();
  }
});

test('人工报告可携带监管时限，并生成合规沟通任务', async () => {
  const { base, close } = await fresh();
  try {
    const res = await api(base, 'POST', '/incidents', {
      body: { country: 'DE', title: '监管询问：交易数据导出', impact: 'branch', sensitivity: 'restricted', regulatoryDeadline: '2026-09-25T00:00:00.000Z' },
      actor: 'de-ops',
    });
    const inc = res.data.incident;
    assert.equal(inc.source, 'manual');
    assert.equal(inc.regulatoryDeadline, '2026-09-25T00:00:00.000Z');
    const notifs = (await api(base, 'GET', `/notifications?incidentId=${inc.id}`)).data.notifications;
    assert.ok(notifs.some((n) => n.kind === 'regulatory_deadline' && n.audience === 'emea-compliance-desk'));
  } finally {
    await close();
  }
});

test('同一告警重复到达：不重复建事件，留痕且通知去重', async () => {
  const { base, close } = await fresh();
  try {
    const first = await api(base, 'POST', '/alerts', { body: SG_ALERT });
    const inc = first.data.incident;

    const dup = await api(base, 'POST', '/alerts', { body: SG_ALERT });
    assert.equal(dup.data.duplicated, true);
    assert.equal(dup.data.incident.id, inc.id);
    assert.equal(dup.data.incident.duplicateAlerts, 1);

    const list = (await api(base, 'GET', '/incidents')).data.incidents;
    assert.equal(list.length, 1); // 没有重复建事件

    const retro = (await api(base, 'GET', `/incidents/${inc.id}/retrospective`)).data;
    assert.equal(retro.metrics.alerts.duplicates, 1);
    assert.ok(retro.metrics.notifications.deduped >= 3); // 复跑的沟通计划全部被去重
    assert.ok(retro.timeline.some((e) => e.type === 'alert_duplicate'));
    assert.ok(retro.timeline.some((e) => e.type === 'notification_deduped'));
  } finally {
    await close();
  }
});

test('跨时区升级：路径、时区与次数均可追溯', async () => {
  const { base, close } = await fresh();
  try {
    const res = await api(base, 'POST', '/incidents', {
      body: { country: 'DE', title: '法兰克福分行支付中断', impact: 'country', sensitivity: 'internal' },
    });
    const inc = res.data.incident;

    const e1 = await api(base, 'POST', `/incidents/${inc.id}/escalate`, { body: { reason: '本地无法定位' } });
    assert.equal(e1.data.incident.level, 2);
    assert.equal(e1.data.incident.assignee, 'emea-regional-command');

    const e2 = await api(base, 'POST', `/incidents/${inc.id}/escalate`, { body: { reason: '需总部协调' } });
    assert.equal(e2.data.incident.level, 3);
    assert.equal(e2.data.incident.assignee, 'hq-command-center');

    const e3 = await api(base, 'POST', `/incidents/${inc.id}/escalate`, { body: {} });
    assert.equal(e3.status, 409); // 已到总部层

    const retro = (await api(base, 'GET', `/incidents/${inc.id}/retrospective`)).data;
    assert.equal(retro.metrics.escalationCount, 2);
    assert.equal(retro.metrics.crossTimezoneEscalations, 2);
    const escalations = retro.timeline.filter((e) => e.type === 'escalated');
    assert.equal(escalations[0].fromTz, 'Europe/Berlin');
    assert.equal(escalations[0].toTz, 'Europe/London');
    assert.equal(escalations[1].fromTz, 'Europe/London');
    assert.equal(escalations[1].toTz, 'Asia/Shanghai');
  } finally {
    await close();
  }
});

test('影响范围扩大可追溯，等级随之重算，缩小被拒绝', async () => {
  const { base, close } = await fresh();
  try {
    const res = await api(base, 'POST', '/incidents', {
      body: { country: 'SG', title: '单网点支付缓慢', impact: 'branch', sensitivity: 'confidential' },
    });
    const inc = res.data.incident;
    assert.equal(inc.severity, 'SEV4');

    const s1 = await api(base, 'POST', `/incidents/${inc.id}/scope`, { body: { impact: 'country', reason: '扩散到全国网点' } });
    assert.equal(s1.data.incident.impact, 'country');
    assert.equal(s1.data.incident.severity, 'SEV3');

    const s2 = await api(base, 'POST', `/incidents/${inc.id}/scope`, { body: { impact: 'multi_country' } });
    assert.equal(s2.data.incident.severity, 'SEV2'); // 高等级触发公关与合规沟通任务
    const notifs = (await api(base, 'GET', `/notifications?incidentId=${inc.id}`)).data.notifications;
    assert.ok(notifs.some((n) => n.kind === 'scope_expanded' && n.audience === 'apac-pr-desk'));

    const s3 = await api(base, 'POST', `/incidents/${inc.id}/scope`, { body: { impact: 'branch' } });
    assert.equal(s3.status, 409); // 不允许缩小

    const retro = (await api(base, 'GET', `/incidents/${inc.id}/retrospective`)).data;
    assert.equal(retro.metrics.scopeExpansions, 2);
  } finally {
    await close();
  }
});

test('误报关闭可追溯，未完成的沟通任务被注销', async () => {
  const { base, close } = await fresh();
  try {
    const res = await api(base, 'POST', '/incidents', {
      body: { country: 'US', title: '疑似支付中断', impact: 'branch', sensitivity: 'internal' },
    });
    const inc = res.data.incident;
    const before = (await api(base, 'GET', `/notifications?incidentId=${inc.id}&status=pending`)).data.notifications;
    assert.ok(before.length > 0);

    const closed = await api(base, 'POST', `/incidents/${inc.id}/close`, {
      body: { resolution: 'false_alarm', reason: '监控探针误报' }, actor: 'us-duty-manager',
    });
    assert.equal(closed.data.incident.status, 'closed_false_alarm');

    const retro = (await api(base, 'GET', `/incidents/${inc.id}/retrospective`)).data;
    assert.equal(retro.metrics.falseAlarm, true);
    assert.equal(retro.metrics.notifications.pending, 0);
    assert.ok(retro.metrics.notifications.cancelled > 0);
    assert.ok(retro.timeline.some((e) => e.type === 'closed' && e.resolution === 'false_alarm'));

    const again = await api(base, 'POST', `/incidents/${inc.id}/escalate`, { body: {} });
    assert.equal(again.status, 409); // 已关闭事件不能再操作
  } finally {
    await close();
  }
});

test('敏感附件按角色隔离，访问无论成败都留痕', async () => {
  const { base, close } = await fresh();
  try {
    const res = await api(base, 'POST', '/incidents', {
      body: { country: 'SG', title: '客户数据疑似泄露', impact: 'country', sensitivity: 'restricted' },
    });
    const inc = res.data.incident;
    const att = (await api(base, 'POST', `/incidents/${inc.id}/attachments`, {
      body: { name: '涉事账户清单.csv', sensitivity: 'restricted', content: 'acct,amount\nA1,100' }, actor: 'sg-tech-oncall',
    })).data.attachment;

    const asPr = await api(base, 'GET', `/incidents/${inc.id}/attachments/${att.id}`, { role: 'pr' });
    assert.equal(asPr.status, 403);
    const asTech = await api(base, 'GET', `/incidents/${inc.id}/attachments/${att.id}`, { role: 'branch_tech' });
    assert.equal(asTech.status, 403);
    const asCompliance = await api(base, 'GET', `/incidents/${inc.id}/attachments/${att.id}`, { role: 'compliance' });
    assert.equal(asCompliance.status, 200);
    assert.equal(asCompliance.data.attachment.content, 'acct,amount\nA1,100');

    const retro = (await api(base, 'GET', `/incidents/${inc.id}/retrospective`)).data;
    assert.equal(retro.timeline.filter((e) => e.type === 'attachment_access_denied').length, 2);
    assert.equal(retro.timeline.filter((e) => e.type === 'attachment_accessed').length, 1);
  } finally {
    await close();
  }
});

test('外发必须审批：未批准不发送，审批人不能是申请人', async () => {
  const { base, close } = await fresh();
  try {
    const res = await api(base, 'POST', '/incidents', {
      body: { country: 'SG', title: '支付中断需通报监管', impact: 'country', sensitivity: 'confidential' },
    });
    const inc = res.data.incident;

    const req = (await api(base, 'POST', `/incidents/${inc.id}/external-requests`, {
      body: { recipient: 'mas@example.gov', message: '支付中断初步说明' }, actor: 'sg-duty-manager',
    })).data.request;
    assert.equal(req.status, 'pending_approval');

    let retro = (await api(base, 'GET', `/incidents/${inc.id}/retrospective`)).data;
    assert.equal(retro.timeline.some((e) => e.type === 'external_sent'), false); // 未批准不得外发

    const selfApprove = await api(base, 'POST', `/external-requests/${req.id}/decide`, {
      body: { decision: 'approved' }, actor: 'sg-duty-manager', role: 'compliance',
    });
    assert.equal(selfApprove.status, 403); // 审批人不能是申请人

    const wrongRole = await api(base, 'POST', `/external-requests/${req.id}/decide`, {
      body: { decision: 'approved' }, actor: 'hq-someone', role: 'pr',
    });
    assert.equal(wrongRole.status, 403); // 公关无权审批

    const ok = await api(base, 'POST', `/external-requests/${req.id}/decide`, {
      body: { decision: 'approved' }, actor: 'hq-compliance-lead', role: 'compliance',
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.data.request.status, 'sent');

    retro = (await api(base, 'GET', `/incidents/${inc.id}/retrospective`)).data;
    assert.ok(retro.timeline.some((e) => e.type === 'external_request_approved'));
    assert.ok(retro.timeline.some((e) => e.type === 'external_sent'));
    assert.equal(retro.metrics.external.sent, 1);
  } finally {
    await close();
  }
});

test('事件合并只建立关联，原始时间线保留，重复告警归并主事件', async () => {
  const { base, close } = await fresh();
  try {
    const a = (await api(base, 'POST', '/alerts', { body: { ...SG_ALERT, fingerprint: 'sg-core-a', title: '核心支付告警A' } })).data.incident;
    const b = (await api(base, 'POST', '/alerts', { body: { ...SG_ALERT, fingerprint: 'sg-core-b', title: '核心支付告警B' } })).data.incident;

    await api(base, 'POST', `/incidents/${a.id}/escalate`, { body: { reason: '影响扩大' } });

    const merged = await api(base, 'POST', `/incidents/${b.id}/merge`, { body: { otherId: a.id, reason: '同一根因' } });
    assert.equal(merged.data.secondary.status, 'merged');
    assert.equal(merged.data.secondary.mergedInto, a.id);
    assert.ok(merged.data.primary.related.includes(b.id));

    // 原始时间线不被抹掉
    const bTimeline = (await api(base, 'GET', `/incidents/${b.id}/timeline`)).data.events;
    assert.ok(bTimeline.some((e) => e.type === 'incident_created'));
    assert.ok(bTimeline.some((e) => e.type === 'merge_linked' && e.side === 'secondary'));
    const aTimeline = (await api(base, 'GET', `/incidents/${a.id}/timeline`)).data.events;
    assert.ok(aTimeline.some((e) => e.type === 'escalated'));
    assert.ok(aTimeline.some((e) => e.type === 'merge_linked' && e.side === 'primary'));

    // 被合并事件的指纹改指主事件
    const dup = await api(base, 'POST', '/alerts', { body: { ...SG_ALERT, fingerprint: 'sg-core-b' } });
    assert.equal(dup.data.duplicated, true);
    assert.equal(dup.data.incident.id, a.id);
  } finally {
    await close();
  }
});

test('停机恢复后未完成的通知和确认继续存在', async () => {
  const dir = await tempDir();
  const first = await startServer(dir);
  let incId; let pendingIds;
  try {
    const res = await api(first.base, 'POST', '/alerts', { body: SG_ALERT });
    incId = res.data.incident.id;
    await api(first.base, 'POST', `/incidents/${incId}/escalate`, { body: { reason: '跨时区升级' } });
    const pending = (await api(first.base, 'GET', `/notifications?incidentId=${incId}&status=pending`)).data.notifications;
    assert.ok(pending.length > 0);
    pendingIds = pending.map((n) => n.id).sort();
  } finally {
    await first.close(); // 模拟停机
  }

  const second = await startServer(dir); // 同一数据目录恢复
  try {
    const pending = (await api(second.base, 'GET', `/notifications?incidentId=${incId}&status=pending`)).data.notifications;
    assert.deepEqual(pending.map((n) => n.id).sort(), pendingIds); // 未完成的通知仍在

    const retro = (await api(second.base, 'GET', `/incidents/${incId}/retrospective`)).data;
    assert.equal(retro.metrics.escalationCount, 1); // 升级次数也恢复

    const ack = await api(second.base, 'POST', `/notifications/${pendingIds[0]}/ack`, { actor: 'sg-tech-oncall' });
    assert.equal(ack.data.notification.status, 'acknowledged'); // 恢复后可继续确认
  } finally {
    await second.close();
  }

  const third = await startServer(dir); // 再次重启，确认结果依然保留
  try {
    const acked = (await api(third.base, 'GET', `/notifications?incidentId=${incId}&status=acknowledged`)).data.notifications;
    assert.deepEqual(acked.map((n) => n.id), [pendingIds[0]]);
    const pending = (await api(third.base, 'GET', `/notifications?incidentId=${incId}&status=pending`)).data.notifications;
    assert.equal(pending.length, pendingIds.length - 1);
  } finally {
    await third.close();
  }
});

test('最终确认：双分行同时上报、监管时限提前、责任人交接与复盘核对', async () => {
  const { base, close } = await fresh();
  try {
    // 1. 两个分行同时上报
    const [sgRes, usRes] = await Promise.all([
      api(base, 'POST', '/alerts', {
        body: { ...SG_ALERT, fingerprint: 'sg-pay-001', regulatoryDeadline: '2026-09-20T00:00:00.000Z' },
      }),
      api(base, 'POST', '/alerts', {
        body: { country: 'US', branchId: 'US-001', fingerprint: 'us-pay-001', title: '纽约分行支付延迟', impact: 'branch', sensitivity: 'internal' },
      }),
    ]);
    const sg = sgRes.data.incident;
    const us = usRes.data.incident;
    assert.notEqual(sg.id, us.id);
    assert.equal((await api(base, 'GET', '/incidents?status=open')).data.incidents.length, 2);

    // 2. 新加坡事件两次跨时区升级
    await api(base, 'POST', `/incidents/${sg.id}/escalate`, { body: { reason: '影响扩大' } });
    await api(base, 'POST', `/incidents/${sg.id}/escalate`, { body: { reason: '需总部接管' } });

    // 3. 同一告警重复到达（通知仍 pending，应全部去重）
    const dup = await api(base, 'POST', '/alerts', { body: { ...SG_ALERT, fingerprint: 'sg-pay-001' } });
    assert.equal(dup.data.duplicated, true);

    // 4. 监管时限提前
    const dl = await api(base, 'POST', `/incidents/${sg.id}/deadline`, {
      body: { deadline: '2026-09-18T12:00:00.000Z', reason: '监管要求提前口头汇报' }, actor: 'apac-compliance-desk',
    });
    assert.equal(dl.data.incident.regulatoryDeadline, '2026-09-18T12:00:00.000Z');

    // 5. 责任人交接
    const ho = await api(base, 'POST', `/incidents/${sg.id}/handover`, {
      body: { to: 'hq-senior-duty-manager', reason: '跨时区交接班' }, actor: 'hq-command-center',
    });
    assert.equal(ho.data.incident.assignee, 'hq-senior-duty-manager');

    // 6. 纽约事件确认为误报关闭
    await api(base, 'POST', `/incidents/${us.id}/close`, { body: { resolution: 'false_alarm', reason: '压测流量误判' } });

    // 7. 复盘核对：升级次数、通知去重、时限提前、交接与完整时间线
    const retro = (await api(base, 'GET', `/incidents/${sg.id}/retrospective`)).data;
    assert.equal(retro.metrics.escalationCount, 2);
    assert.equal(retro.metrics.alerts.duplicates, 1);
    assert.ok(retro.metrics.notifications.deduped >= 1);
    assert.equal(retro.metrics.handovers, 1);
    assert.equal(retro.metrics.deadlineChanges.length, 1);
    assert.ok(retro.metrics.deadlineChanges[0].to < retro.metrics.deadlineChanges[0].from); // 时限提前
    for (const type of ['incident_created', 'alert_received', 'escalated', 'alert_duplicate', 'deadline_changed', 'handover', 'notification_deduped']) {
      assert.ok(retro.timeline.some((e) => e.type === type), `时间线缺少 ${type}`);
    }

    const usRetro = (await api(base, 'GET', `/incidents/${us.id}/retrospective`)).data;
    assert.equal(usRetro.metrics.falseAlarm, true);
    assert.ok(usRetro.metrics.notifications.cancelled > 0);
  } finally {
    await close();
  }
});

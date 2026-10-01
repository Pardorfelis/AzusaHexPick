import test from 'node:test';
import assert from 'node:assert/strict';
import { PanelEngine } from '../src/engine.mjs';
import { AiService } from '../src/ai-service.mjs';

const interpretation = (command = '2') => ({ command, uncertain: command === null });
const response = (items, usage = { prompt_tokens: 100, completion_tokens: 10 }, extra = {}) => ({
  ok: true, async json() { return { usage, choices: [{ finish_reason: 'stop',
    message: { content: JSON.stringify({ items, ...extra }) } }] }; },
});
const confirmed = request => {
  const body = JSON.parse(request.body);
  assert.ok(body.messages.some(message => /json/i.test(message.content)), '官方 JSON 模式要求提示词包含 JSON 字样。');
  return response(JSON.parse(body.messages[1].content).cases.map(item => ({ id: item.id, ...interpretation(item.candidate) })));
};

function fixture(fetcher = async () => { throw new Error('意外的模拟请求。'); }, { key = 'mock-only', seconds = 10, counting = 'messages' } = {}) {
  let now = 0;
  let sequence = 0;
  const engine = new PanelEngine({ now: () => now });
  engine.setConnection('connected', 'mock-source');
  engine.startRound({ mode: 'hex', seconds, counting });
  const service = new AiService({ engine, key, fetcher });
  const send = (text, anonymousId = null) => engine.ingest({ id: `hex:${++sequence}`, text,
    anonymousId, source: engine.source, at: now });
  return { engine, service, send, setTime(value) { now = value; },
    pending(text = '2收集者', anonymousId = null) {
      const value = send(text, anonymousId); assert.equal(value.pending, true, text); return value.messageKey;
    }, local(count) { for (let index = 0; index < count; index++) send('1'); } };
}

test('海克斯默认关闭，装备开关不能意外启用海克斯，任一开关都需要密钥', async () => {
  let calls = 0;
  const f = fixture(async (_url, request) => { calls++; return confirmed(request); });
  f.setTime(3000); f.pending(); await f.service.tick();
  assert.equal(f.service.snapshot().hexEnabled, false);
  assert.equal(f.service.snapshot().hexPolicy.status, 'off');
  f.service.configure({ enabled: true }); await f.service.tick();
  assert.equal(calls, 0);
  assert.equal(f.service.snapshot().enabled, true);
  assert.equal(f.service.snapshot().hexEnabled, false);
  const missing = fixture(undefined, { key: '' });
  assert.throws(() => missing.service.configure({ hexEnabled: true }), /密钥/);
  assert.throws(() => missing.service.configure({ enabled: true }), /密钥/);
});

test('末段仅剩过时未决时不请求，也不提示正在处理近期建议', async () => {
  let calls = 0;
  const f = fixture(async (_url, request) => { calls++; return confirmed(request); }, { seconds: 30 });
  f.pending();
  f.service.configure({ hexEnabled: true });
  f.setTime(23000);
  assert.equal(f.service.snapshot().hexPolicy.status, 'no-pending');
  await f.service.tick();
  assert.equal(calls, 0);
});

test('两个开关独立保留当前值，各模式使用自己的输出结构', async () => {
  let hexCalls = 0; let equipmentCalls = 0;
  const f = fixture(async (_url, request) => {
    const user = JSON.parse(JSON.parse(request.body).messages[1].content);
    if (user.mode === 'hex') { hexCalls++; return confirmed(request); }
    equipmentCalls++;
    return response([{ id: '0', current: ['中娅沙漏'], later: [], alternatives: [], against: [], conditional: [], uncertain: false }]);
  });
  f.service.configure({ hexEnabled: true });
  assert.equal(f.service.snapshot().enabled, false);
  f.setTime(3000); f.pending(); await f.service.tick();
  assert.equal(hexCalls, 1);
  f.engine.startRound({ mode: 'equipment', seconds: 30 });
  f.pending('金身不香吗'); await f.service.tick();
  assert.equal(equipmentCalls, 0);
  assert.equal(f.service.snapshot().hexPolicy.status, 'off');
  f.service.configure({ enabled: true });
  assert.equal(f.service.snapshot().hexEnabled, true);
  await f.service.tick();
  assert.equal(equipmentCalls, 1);
  assert.equal(f.engine.snapshot().equipment.top3[0].name, '中娅沙漏');
  f.service.configure({ hexEnabled: false });
  assert.equal(f.service.snapshot().enabled, true);
});

test('满三秒且进入最后七秒才允许请求，最后不足一千二百毫秒拒绝', async () => {
  for (const [seconds, now, expected, policy] of [
    [10, 0, 0, 'waiting'], [10, 2999, 0, 'waiting'], [10, 3000, 1, 'active'],
    [30, 3000, 0, 'waiting'], [30, 22999, 0, 'waiting'], [30, 23000, 1, 'active'],
    [10, 8800, 1, 'active'], [10, 8801, 0, 'deadline'],
  ]) {
    let calls = 0;
    const f = fixture(async (_url, request) => { calls++; return confirmed(request); }, { seconds });
    f.service.configure({ hexEnabled: true }); f.setTime(now); f.pending();
    assert.equal(f.service.snapshot().hexPolicy.status, policy);
    await f.service.tick(); assert.equal(calls, expected, `${seconds}／${now}`);
  }
});

test('十九条本地票仍可补充，二十条在早段和末段均跳过 AI', async () => {
  for (const [local, now, expected] of [[19, 3000, 1], [20, 0, 0], [20, 3000, 0]]) {
    let calls = 0;
    const f = fixture(async (_url, request) => { calls++; return confirmed(request); });
    f.service.configure({ hexEnabled: true }); f.local(local); f.setTime(now); f.pending();
    if (local === 20) assert.equal(f.service.snapshot().hexPolicy.status, 'enough-local');
    await f.service.tick(); assert.equal(calls, expected);
    assert.equal(f.engine.snapshot().hexDiagnostics.localVotes, local);
  }
});

test('完整文字与唯一候选进入请求，每批最多三条，不给技能名猜编号', async () => {
  let cases;
  const text = '2配合装备' + '讨论'.repeat(100);
  const f = fixture(async (_url, request) => {
    const body = JSON.parse(request.body); const user = JSON.parse(body.messages[1].content);
    cases = user.cases;
    assert.equal(user.mode, 'hex'); assert.equal(user.roundActive, true);
    assert.deepEqual(user.allowedCommands, ['1', '2', '3', '1d', '2d', '3d', 'd', '12d', '13d', '23d']);
    assert.match(body.messages[0].content, /组合刷新不能拆成多条指令/);
    assert.match(body.messages[0].content, /纯技能名不能猜编号/);
    assert.match(body.messages[0].content, /不能改成其他指令/);
    assert.equal(body.max_tokens, 512); assert.equal(body.thinking.type, 'disabled');
    return confirmed(request);
  });
  f.service.configure({ hexEnabled: true }); f.setTime(3000);
  f.send('珠光'); f.send('法爆');
  assert.equal(f.service.snapshot().hexPolicy.status, 'no-pending');
  f.pending(text); f.pending('1配合装备'); f.pending('3配合装备'); f.pending('2然后收集者');
  await f.service.tick();
  assert.equal(cases.length, 3); assert.equal(cases[0].text, text);
  assert.deepEqual(cases.map(value => value.candidate), ['2', '1', '3']);
  assert.equal(f.engine.snapshot().hexDiagnostics.aiVotes, 3);
  assert.equal(f.engine.listPending().length, 1);
  assert.equal(JSON.stringify(f.service.snapshot()).includes('mock-only'), false);
});

test('错误编号、重复编号、换候选和不完整结构均整批拒绝，不部分计票', async () => {
  const variants = [
    [{ id: '0', ...interpretation() }, { id: 'outside', ...interpretation('1') }],
    [{ id: '0', ...interpretation() }, { id: '0', ...interpretation('1') }],
    [{ id: '0', ...interpretation() }, { id: '1', ...interpretation('3') }],
    [{ id: '0', ...interpretation() }, { id: '1', command: '1' }],
    [{ id: '0', ...interpretation() }, { id: '1', ...interpretation('1'), votes: 999 }],
    [{ id: '0', ...interpretation() }, { id: '1', command: '1', uncertain: true }],
    [{ id: '0', ...interpretation() }, { id: '1', command: null, uncertain: false }],
  ];
  for (const items of variants) {
    let calls = 0; const f = fixture(async () => { calls++; return response(items); });
    f.service.configure({ enabled: true, hexEnabled: true }); f.setTime(3000);
    f.pending(); f.pending('1配合装备'); await f.service.tick(); await f.service.tick();
    assert.equal(calls, 1); assert.equal(f.engine.snapshot().hexDiagnostics.aiVotes, 0);
    assert.equal(f.service.snapshot().enabled, false); assert.equal(f.service.snapshot().hexEnabled, false);
    assert.equal(f.service.snapshot().costUnknown, false);
  }
});

test('不确定结果不分票，外层额外字段仍拒绝', async () => {
  for (const extra of [{}, { command: '2' }]) {
    const f = fixture(async () => response([{ id: '0', ...interpretation(null) }], undefined, extra));
    f.service.configure({ hexEnabled: true }); f.setTime(3000); f.pending(); await f.service.tick();
    assert.equal(f.engine.snapshot().hexDiagnostics.aiVotes, 0);
    assert.equal(f.service.snapshot().hexEnabled, Object.keys(extra).length === 0);
    if (!Object.keys(extra).length) assert.equal(f.service.snapshot().hexPolicy.status, 'no-pending');
  }
});

test('换轮、改口、反对撤回、断连、过期或在途补足本地票时旧结果不回填', async () => {
  for (const change of ['round', 'local', 'against', 'disconnect', 'deadline-equal', 'expired', 'enough']) {
    let finish; const f = fixture(() => new Promise(resolve => { finish = resolve; }));
    f.service.configure({ hexEnabled: true }); f.setTime(3000); f.pending('2收集者', 'a');
    const working = f.service.tick();
    if (change === 'round') f.engine.startRound();
    else if (change === 'local') f.send('1', 'a');
    else if (change === 'against') f.send('别选2', 'a');
    else if (change === 'disconnect') f.engine.setConnection('disconnected', 'mock-source');
    else if (change === 'deadline-equal') f.setTime(8000);
    else if (change === 'expired') f.setTime(8001);
    else f.local(20);
    finish(response([{ id: '0', ...interpretation() }])); await working;
    assert.equal(f.engine.snapshot().hexDiagnostics.aiVotes, 0, change);
    assert.equal(f.service.snapshot().costUnknown, false);
    if (change === 'enough') assert.equal(f.service.snapshot().hexPolicy.status, 'enough-local');
    if (change === 'round') assert.equal(f.service.snapshot().hexPolicy.status, 'waiting');
  }
});

test('匿名支持被明确撤回后不再显示，已经收到的弹幕条数历史仍保留', async () => {
  const f = fixture(async (_url, request) => confirmed(request), { counting: 'anonymous' });
  f.service.configure({ hexEnabled: true }); f.setTime(3000); f.pending('2收集者', 'a');
  await f.service.tick();
  assert.equal(f.engine.snapshot().hex.find(item => item.key === '2').votes, 1);
  f.send('别选2', 'a');
  const item = f.engine.snapshot().hex.find(value => value.key === '2');
  assert.equal(item.votes, 0); assert.equal(item.anonymousVotes, 0); assert.equal(item.messageVotes, 1);
  assert.equal(f.service.snapshot().hexPolicy.status, 'no-pending');
});

test('等待下一轮的旧 pending 不消耗费用，新轮状态从当前快照派生', async () => {
  let calls = 0; const f = fixture(async (_url, request) => { calls++; return confirmed(request); }, { seconds: 30 });
  f.service.configure({ hexEnabled: true }); f.pending(); f.setTime(23000); await f.service.tick();
  assert.equal(calls, 0);
  assert.equal(f.service.snapshot().hexPolicy.status, 'no-pending');
  f.engine.startRound({ seconds: 10 });
  assert.equal(f.service.snapshot().hexPolicy.status, 'waiting');
  f.setTime(26000); f.pending(); await f.service.tick(); assert.equal(calls, 1);
  f.engine.lockRound(); assert.equal(f.service.snapshot().hexPolicy.status, 'deadline');
});

test('取消后晚到结果不回填，返回的合法用量仍记费，并关闭两个开关', async () => {
  let finish; const f = fixture(() => new Promise(resolve => { finish = resolve; }));
  f.service.configure({ enabled: true, hexEnabled: true }); f.setTime(3000); f.pending();
  const working = f.service.tick(); f.service.stop();
  finish(response([{ id: '0', ...interpretation() }])); await working;
  assert.equal(f.engine.snapshot().hexDiagnostics.aiVotes, 0);
  assert.equal(f.service.snapshot().enabled, false); assert.equal(f.service.snapshot().hexEnabled, false);
  assert.equal(f.service.snapshot().costUnknown, false); assert.equal(f.service.snapshot().estimatedPeakCostCny, 0.00028);
});

test('超时和 HTTP 失败不重试，费用未知后两个开关都不能再次启用', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0; const f = fixture(async (_url, { signal }) => {
    calls++; await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('mock abort')), { once: true }));
  });
  f.service.configure({ enabled: true, hexEnabled: true }); f.setTime(3000); f.pending();
  const working = f.service.tick(); t.mock.timers.tick(4001); await working; await f.service.tick();
  assert.equal(calls, 1); assert.match(f.service.snapshot().error, /超时/);
  assert.equal(f.service.snapshot().costUnknown, true); assert.equal(f.service.snapshot().hexEnabled, false);
  assert.throws(() => f.service.configure({ hexEnabled: true }), /费用未知/);
  assert.throws(() => f.service.configure({ enabled: true }), /费用未知/);
  let failedCalls = 0; const failed = fixture(async () => { failedCalls++; return { ok: false, status: 429 }; });
  failed.service.configure({ enabled: true, hexEnabled: true }); failed.setTime(3000); failed.pending();
  await failed.service.tick(); await failed.service.tick();
  assert.equal(failedCalls, 1); assert.equal(failed.service.snapshot().enabled, false);
  assert.equal(failed.service.snapshot().hexEnabled, false);
});

test('缺失用量暂停两种 AI，不把费用报告为已知', async () => {
  const f = fixture(async () => response([{ id: '0', ...interpretation() }], null));
  f.service.configure({ enabled: true, hexEnabled: true }); f.setTime(3000); f.pending(); await f.service.tick();
  assert.equal(f.service.snapshot().costUnknown, true);
  assert.equal(f.service.snapshot().enabled, false); assert.equal(f.service.snapshot().hexEnabled, false);
  assert.equal(f.engine.snapshot().hexDiagnostics.aiVotes, 0);
});

test('海克斯仍遵守四次轮请求上限和跨轮会话预算', async () => {
  let calls = 0; const f = fixture(async () => { calls++; return response([{ id: '0', ...interpretation(null) }]); });
  f.service.configure({ hexEnabled: true }); f.setTime(3000);
  for (let index = 0; index < 5; index++) { f.pending(`2配合装备${'啊'.repeat(index)}`); await f.service.tick(); }
  assert.equal(calls, 4); assert.match(f.service.snapshot().error, /预算/);
  const reserved = f.service.sessionReserved;
  f.engine.startRound(); f.setTime(6000); f.pending(); await f.service.tick();
  assert.equal(calls, 5); assert.ok(f.service.sessionReserved > reserved);
});

test('预算不足时不创建海克斯任务，待识别保持原状', async () => {
  for (const budget of ['sessionReserved', 'roundReserved']) {
    let calls = 0; const f = fixture(async (_url, request) => { calls++; return confirmed(request); });
    f.service.configure({ hexEnabled: true }); f.setTime(3000); f.pending();
    f.service.roundId = f.engine.snapshot().roundId;
    f.service[budget] = budget === 'sessionReserved' ? 0.999999 : 0.099999;
    await f.service.tick(); assert.equal(calls, 0);
    assert.equal(f.engine.listPending().length, 1); assert.equal(f.engine.tickets.size, 0);
  }
});

test('组合刷新保留完整唯一动作，反序输入规范化后仍只产生一条弹幕票', async () => {
  for (const [text, command] of [['12d配合装备', '12d'], ['13d配合装备', '13d'],
    ['23d配合装备', '23d'], ['21d配合装备', '12d']]) {
    let sourceCase;
    const f = fixture(async (_url, request) => {
      sourceCase = JSON.parse(JSON.parse(request.body).messages[1].content).cases[0];
      return response([{id: '0', ...interpretation(command)}]);
    });
    f.service.configure({hexEnabled: true}); f.setTime(3000); f.pending(text); await f.service.tick();
    assert.equal(sourceCase.candidate, command);
    assert.equal(f.engine.snapshot().hexDiagnostics.aiVotes, 1);
    assert.equal(f.engine.snapshot().validMessages, 1);
    assert.equal(f.engine.snapshot().hex.find(item => item.key === command).messageVotes, 1);
    assert.equal(f.engine.snapshot().hex.find(item => item.key === '1d').messageVotes, 0);
    assert.equal(f.engine.snapshot().hex.find(item => item.key === '2d').messageVotes, 0);
  }
});

test('模型不能把组合刷新拆成单项、数组或改成全部刷新', async () => {
  for (const command of ['1d', '2d', 'd', ['1d', '2d']]) {
    const f = fixture(async () => response([{id: '0', command, uncertain: false}]));
    f.service.configure({hexEnabled: true}); f.setTime(3000); f.pending('12d配合装备'); await f.service.tick();
    assert.equal(f.engine.snapshot().hexDiagnostics.aiVotes, 0);
    assert.equal(f.service.snapshot().hexEnabled, false);
    assert.equal(f.service.cache.size, 0);
  }
});

test('海克斯同文合批和缓存不拆票，也不突破本地二十条后的跳过策略', async () => {
  let calls = 0; let cases;
  const f = fixture(async (_url, request) => {
    calls++; cases = JSON.parse(JSON.parse(request.body).messages[1].content).cases;
    return confirmed(request);
  });
  f.service.configure({hexEnabled: true}); f.setTime(3000);
  f.pending('12d配合装备', 'a'); f.pending('12d配合装备', 'b'); await f.service.tick();
  assert.equal(cases.length, 1); assert.equal(calls, 1);
  assert.equal(f.engine.snapshot().hex.find(item => item.key === '12d').messageVotes, 2);
  f.setTime(3100); f.pending('12d配合装备', 'c'); await f.service.tick();
  assert.equal(calls, 1); assert.equal(f.engine.snapshot().hexDiagnostics.aiVotes, 3);
  f.local(20); f.pending('12d配合装备', 'd'); await f.service.tick();
  assert.equal(calls, 1); assert.equal(f.engine.snapshot().hexDiagnostics.aiVotes, 3);
  assert.equal(f.service.snapshot().hexPolicy.status, 'enough-local');
});

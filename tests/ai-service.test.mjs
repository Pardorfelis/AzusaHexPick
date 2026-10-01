import test from 'node:test';
import assert from 'node:assert/strict';
import { PanelEngine } from '../src/engine.mjs';
import { AiService } from '../src/ai-service.mjs';

const HAT = '灭世者的死亡之帽';
const GOLD = '中娅沙漏';
const fields = (current = [], against = [], uncertain = false) => ({ current, later: [], alternatives: [], against, conditional: [], uncertain });
const response = (items, usage = { prompt_tokens: 100, completion_tokens: 10 }, extra = {}) => ({
  ok: true, status: 200, async json() {
    return { usage, choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ items, ...extra }) } }] };
  },
});

function fixture(fetcher) {
  let now = 0;
  let sequence = 0;
  const engine = new PanelEngine({ now: () => now });
  engine.setConnection('connected', 'mock-source');
  engine.startRound({ mode: 'equipment', seconds: 30 });
  const service = new AiService({ engine, key: 'mock-only', fetcher });
  service.configure({ enabled: true });
  return { engine, service, setTime(value) { now = value; }, pending(text = '帽子不香吗', anonymousId = null) {
    const id = `m${++sequence}`;
    const received = engine.ingest({ id, text, anonymousId, source: 'mock-source', at: now });
    assert.equal(received.pending, true);
    return id;
  }, send(text, anonymousId) {
    engine.ingest({ id: `m${++sequence}`, text, anonymousId, source: 'mock-source', at: now });
  } };
}

test('长表达保留尾部否定，不为限制提示词长度截断票意', async () => {
  const text = '出帽子' + '讨论'.repeat(90) + '？先别出帽子';
  let calls = 0;
  const f = fixture(async (_url, request) => {
    calls += 1;
    const envelope = JSON.parse(request.body);
    const user = JSON.parse(envelope.messages[1].content);
    assert.equal(user.cases[0].text, text);
    assert.ok(user.cases[0].text.endsWith('先别出帽子'));
    return response([{id:'0', ...fields([], [], true)}]);
  });
  f.pending(text);
  await f.service.tick();
  assert.equal(calls, 1);
  assert.deepEqual(f.engine.snapshot().equipment.top3, []);
});

test('模拟正确的否定与首选结果保留两种意见，密钥不进入快照', async () => {
  let calls = 0;
  const f = fixture(async (_url, request) => {
    calls += 1;
    assert.equal(request.headers.Authorization, 'Bearer mock-only');
    return response([{ id: '0', ...fields([GOLD], [HAT]) }]);
  });
  f.pending('帽子金身我觉得，别出帽子，金身才该现在买', 'a');
  await f.service.tick();
  assert.equal(calls, 1);
  assert.deepEqual(f.engine.snapshot().equipment.top3.map(item => [item.name, item.votes]), [[GOLD, 1]]);
  assert.deepEqual(f.engine.snapshot().equipment.against.map(item => [item.name, item.votes]), [[HAT, 1]]);
  assert.equal(JSON.stringify(f.service.snapshot()).includes('mock-only'), false);
  assert.equal(JSON.stringify(f.engine.snapshot()).includes('mock-only'), false);
});

test('不完整字段、重复编号、范围外装备与额外操作字段均整批拒绝', async () => {
  const variants = [
    [{ id: '0', current: [GOLD] }, { id: '1', ...fields() }],
    [{ id: '0', ...fields([GOLD]) }, { id: '0', ...fields() }],
    [{ id: '0', ...fields(['杀人书']) }, { id: '1', ...fields() }],
    [{ id: '0', ...fields([GOLD]), command: 'change-counts' }, { id: '1', ...fields() }],
  ];
  for (const items of variants) {
    let calls = 0;
    const f = fixture(async () => { calls += 1; return response(items); });
    f.pending('金身不香吗', 'a'); f.pending('帽子不香吗', 'b');
    await f.service.tick();
    await f.service.tick();
    assert.equal(calls, 1);
    assert.equal(f.service.snapshot().enabled, false);
    assert.equal(f.service.snapshot().costUnknown, false);
    assert.deepEqual(f.engine.snapshot().equipment.top3, []);
  }
});

test('空结果和反问的不确定结果不会强行分票', async () => {
  const f = fixture(async () => response([{ id: '0', ...fields() }, { id: '1', ...fields([], [], true) }]));
  f.pending('金身不香吗', 'a'); f.pending('帽子不香吗', 'b');
  await f.service.tick();
  assert.deepEqual(f.engine.snapshot().equipment.top3, []);
  assert.equal(f.engine.snapshot().pendingCount, 1);
});

test('结果返回前过期、换轮、断连、重连或本地改口，旧结果都不回填', async () => {
  for (const transition of ['expired', 'round', 'disconnect', 'reconnect', 'local']) {
    let finish;
    const f = fixture(() => new Promise(resolve => { finish = resolve; }));
    f.pending('帽子不香吗', 'a');
    const working = f.service.tick();
    if (transition === 'expired') f.setTime(5001);
    else if (transition === 'round') f.engine.startRound();
    else if (transition === 'disconnect') f.engine.setConnection('disconnected', 'mock-source');
    else if (transition === 'reconnect') {
      f.engine.setConnection('disconnected', 'mock-source');
      f.engine.setConnection('connected', 'mock-source-new');
    }
    else f.send('金身', 'a');
    finish(response([{ id: '0', ...fields([HAT]) }]));
    await working;
    assert.equal(f.engine.snapshot().equipment.top3.some(item => item.name === HAT), false);
    if (transition === 'local') assert.equal(f.engine.snapshot().equipment.top3[0].name, GOLD);
  }
});

test('缺失用量时费用未知并停用，不能直接重新启用', async () => {
  let calls = 0;
  const f = fixture(async () => { calls += 1; return response([{ id: '0', ...fields() }], null); });
  f.pending();
  await f.service.tick();
  await f.service.tick();
  assert.equal(calls, 1);
  assert.equal(f.service.snapshot().costUnknown, true);
  assert.throws(() => f.service.configure({ enabled: true }), /费用未知/);
});

test('HTTP 失败不自动重试，也不公开接口或认证错误细节', async () => {
  let calls = 0;
  const f = fixture(async () => { calls += 1; return { ok: false, status: 429 }; });
  f.pending();
  await f.service.tick();
  await f.service.tick();
  assert.equal(calls, 1);
  assert.equal(f.service.snapshot().enabled, false);
  assert.equal(f.service.snapshot().costUnknown, true);
  assert.equal(f.service.snapshot().error.includes('mock-only'), false);
});

test('请求超时会中止，停止后不自动重试', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const f = fixture(async (_url, { signal }) => {
    calls += 1;
    await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('mock abort')), { once: true }));
  });
  f.pending();
  const working = f.service.tick();
  t.mock.timers.tick(4001);
  await working;
  await f.service.tick();
  assert.equal(calls, 1);
  assert.match(f.service.snapshot().error, /超时/);
  assert.equal(f.service.snapshot().busy, false);
});

test('每轮最多四次请求，新轮重置轮预算但保留会话预算', async () => {
  let calls = 0;
  const f = fixture(async () => { calls += 1; return response([{ id: '0', ...fields([], [], true) }]); });
  for (let index = 0; index < 4; index++) {
    f.setTime(index * 7500); f.pending(`帽子不香吗${'啊'.repeat(index)}`); await f.service.tick();
  }
  f.pending('金身不香吗'); await f.service.tick();
  assert.equal(calls, 4);
  assert.match(f.service.snapshot().error, /预算/);
  const reserved = f.service.sessionReserved;
  f.engine.startRound();
  assert.equal(f.service.snapshot().roundRequests, 0);
  assert.equal(f.service.snapshot().error, '');
  f.pending(); await f.service.tick();
  assert.equal(calls, 5);
  assert.ok(f.service.sessionReserved > reserved);
});

test('会话或轮预算不足前不申请任务，待识别不误变为处理中', async () => {
  for (const budget of ['sessionReserved', 'roundReserved']) {
    let calls = 0;
    const f = fixture(async () => { calls += 1; return response([]); });
    f.pending();
    f.service.roundId = f.engine.snapshot().roundId;
    f.service[budget] = budget === 'sessionReserved' ? 0.999999 : 0.099999;
    await f.service.tick();
    assert.equal(calls, 0);
    assert.equal(f.engine.listPending().length, 1);
    assert.equal(f.engine.tickets.size, 0);
  }
});

test('已中止的请求迟到返回不能回填，仍记录返回的已知费用', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let finish;
  const f = fixture(() => new Promise(resolve => { finish = resolve; }));
  f.pending('帽子不香吗', 'a');
  const working = f.service.tick();
  t.mock.timers.tick(4001);
  f.setTime(4001);
  finish(response([{ id: '0', ...fields([HAT]) }]));
  await working;
  assert.deepEqual(f.engine.snapshot().equipment.top3, []);
  assert.equal(f.service.snapshot().enabled, false);
  assert.equal(f.service.snapshot().costUnknown, false);
  assert.equal(f.service.snapshot().estimatedPeakCostCny, 0.00028);
});

test('明确停止后迟到结果不能恢复匿名展示', async () => {
  let finish;
  const f = fixture(() => new Promise(resolve => { finish = resolve; }));
  f.pending('帽子不香吗', 'a');
  const working = f.service.tick();
  f.service.stop();
  finish(response([{ id: '0', ...fields([HAT]) }]));
  await working;
  assert.deepEqual(f.engine.snapshot().equipment.top3, []);
  assert.equal(f.service.snapshot().enabled, false);
  assert.equal(f.service.snapshot().costUnknown, false);
  assert.equal(f.service.snapshot().estimatedPeakCostCny, 0.00028);
});

test('缓存命中与未命中用量矛盾时不得宣称费用已知', async () => {
  const usage = { prompt_tokens: 100, completion_tokens: 10,
    prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 1 };
  const f = fixture(async () => response([{ id: '0', ...fields([HAT]) }], usage));
  f.pending();
  await f.service.tick();
  assert.equal(f.service.snapshot().costUnknown, true);
  assert.equal(f.service.snapshot().enabled, false);
  assert.deepEqual(f.engine.snapshot().equipment.top3, []);
});

test('外层模型 JSON 的额外操作字段也严格拒绝', async () => {
  const f = fixture(async () => response([{ id: '0', ...fields([HAT]) }], undefined, { command: 'change-counts' }));
  f.pending();
  await f.service.tick();
  assert.equal(f.service.snapshot().enabled, false);
  assert.deepEqual(f.engine.snapshot().equipment.top3, []);
});

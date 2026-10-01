import test from 'node:test';
import assert from 'node:assert/strict';
import { PanelEngine } from '../src/engine.mjs';
import { AiService } from '../src/ai-service.mjs';
import { allowedEquipment, equipmentCandidates } from '../src/equipment.mjs';

const HAT = '灭世者的死亡之帽';
const GOLD = '中娅沙漏';
const fields = (current = [], against = [], uncertain = false) => ({current, later: [],
  alternatives: [], against, conditional: [], uncertain});
const response = items => ({ok: true, async json() {
  return {usage: {prompt_tokens: 100, completion_tokens: 10}, choices: [{finish_reason: 'stop',
    message: {content: JSON.stringify({items})}}]};
}});
const readUser = request => JSON.parse(JSON.parse(request.body).messages[1].content);
const uncertainResponse = request => response(readUser(request).cases.map(item => ({id: item.id, ...fields([], [], true)})));

function fixture(fetcher, {seconds = 30, counting = 'messages'} = {}) {
  let now = 0; let sequence = 0;
  const engine = new PanelEngine({now: () => now});
  engine.setConnection('connected', 'mock-source');
  engine.startRound({mode: 'equipment', seconds, counting});
  const service = new AiService({engine, key: 'mock-only', fetcher});
  service.configure({enabled: true});
  const send = (text, anonymousId = null) => engine.ingest({id: `eq:${++sequence}`,
    text, anonymousId, source: engine.source, at: now});
  return {engine, service, send, setTime(value) {now = value;}, pending(text = '帽子不香吗', anonymousId = null) {
    const result = send(text, anonymousId); assert.equal(result.pending, true, text); return result.messageKey;
  }};
}

test('装备四次请求分散到整轮，缓存以外的连发不能提前耗尽预算', async () => {
  const starts = [];
  const f = fixture(async (_url, request) => {starts.push(f.engine.snapshot().now); return uncertainResponse(request);});
  f.pending('帽子不香吗'); await f.service.tick();
  f.setTime(7499); f.pending('金身不香吗'); await f.service.tick();
  assert.deepEqual(starts, [0]);
  assert.equal(f.service.snapshot().equipmentPolicy.status, 'scheduled');
  assert.equal(f.service.snapshot().equipmentPolicy.nextRequestAt, 7500);
  f.setTime(7500); await f.service.tick();
  f.setTime(15000); f.pending('破败不香吗'); await f.service.tick();
  f.setTime(22500); f.pending('公理圆弧不香吗'); await f.service.tick();
  assert.deepEqual(starts, [0, 7500, 15000, 22500]);
  f.pending('帽子难道不香吗'); await f.service.tick();
  assert.equal(f.service.snapshot().roundRequests, 4);
  assert.equal(f.service.snapshot().equipmentPolicy.status, 'request-limit');
  assert.match(f.service.snapshot().error, /次数预算/);
});

test('第一批晚出现时按实际发起时间间隔，不补发已经错过的时段', async () => {
  const starts = [];
  const f = fixture(async (_url, request) => {starts.push(f.engine.snapshot().now); return uncertainResponse(request);});
  f.setTime(10000); f.pending(); await f.service.tick();
  f.setTime(10001); f.pending('金身不香吗'); await f.service.tick();
  assert.deepEqual(starts, [10000]);
  f.setTime(17499); f.pending('破败不香吗'); await f.service.tick();
  assert.equal(f.service.snapshot().equipmentPolicy.nextRequestAt, 17500);
  f.setTime(17500); await f.service.tick();
  assert.deepEqual(starts, [10000, 17500]);
  assert.equal(f.service.snapshot().equipmentPolicy.intervalMs, 7500);
});

test('十秒短轮仍分散请求，最后不足一千二百毫秒不请求', async () => {
  const starts = [];
  const f = fixture(async (_url, request) => {starts.push(f.engine.snapshot().now); return uncertainResponse(request);}, {seconds: 10});
  for (const [index, at] of [0, 2500, 5000, 8750].entries()) {
    f.setTime(at); f.pending(`帽子不香吗${'啊'.repeat(index)}`); await f.service.tick();
  }
  assert.deepEqual(starts, [0, 2500, 5000, 8750]);
  const late = fixture(async (_url, request) => {assert.fail('不应在末段发起请求。'); return uncertainResponse(request);}, {seconds: 10});
  late.setTime(8801); late.pending(); await late.service.tick();
  assert.equal(late.service.snapshot().equipmentPolicy.status, 'deadline');
  assert.equal(late.service.snapshot().roundRequests, 0);
  assert.equal(late.engine.tickets.size, 0);
});

test('旧未决和过期临界消息不挤掉新鲜候选', async () => {
  let texts;
  const f = fixture(async (_url, request) => {texts = readUser(request).cases.map(item => item.text); return uncertainResponse(request);});
  for (let index = 0; index < 50; index++) f.pending(`出陌生装备${'啊'.repeat(index % 3)}`);
  f.pending('金身不香吗');
  f.setTime(5000); f.pending('帽子不香吗'); await f.service.tick();
  assert.deepEqual(texts, ['帽子不香吗']);
  assert.equal(f.service.snapshot().roundRequests, 1);
  assert.equal(f.service.snapshot().equipmentPolicy.unresolvedCount, 1);
});

test('全批没有可靠候选就不请求，混合批仅发送可核对的原文', async () => {
  let calls = 0; let user;
  const f = fixture(async (_url, request) => {calls++; user = readUser(request); return uncertainResponse(request);});
  f.pending('出陌生装备'); f.pending('小绿甲'); await f.service.tick();
  assert.equal(calls, 0); assert.equal(f.service.snapshot().roundRequests, 0);
  assert.equal(f.service.snapshot().equipmentPolicy.status, 'no-candidates');
  assert.equal(f.engine.snapshot().pendingCount, 2);
  f.pending('帽子不香吗'); await f.service.tick();
  assert.equal(calls, 1); assert.deepEqual(user.allowedItems, [HAT]);
  assert.deepEqual(user.cases.map(item => item.text), ['帽子不香吗']);
  assert.equal(f.engine.snapshot().pendingCount, 3);
});

test('最前一百五十条新鲜未知原词不阻挡后面的已知候选', async () => {
  let texts; let calls = 0;
  const f = fixture(async (_url, request) => {calls++; texts = readUser(request).cases.map(item => item.text); return uncertainResponse(request);});
  for (let index = 0; index < 150; index++) f.pending('出陌生装备');
  f.pending('帽子不香吗'); await f.service.tick();
  assert.equal(calls, 1); assert.deepEqual(texts, ['帽子不香吗']);
  assert.equal(f.service.snapshot().roundRequests, 1);
  assert.equal(f.engine.snapshot().pendingCount, 151);
});

test('只有一半能映射的混合原词不请求，也不能借已有缓存填首选', async () => {
  let calls = 0;
  const f = fixture(async (_url, request) => {calls++; return response(readUser(request).cases.map(item => ({id: item.id, ...fields(['无尽之刃'])})));});
  f.pending('无尽不香吗'); await f.service.tick();
  assert.equal(calls, 1); assert.equal(f.engine.snapshot().equipment.top3[0].messageVotes, 1);
  const text = '出无尽＋大穿';
  assert.deepEqual(equipmentCandidates(text), ['无尽之刃']);
  f.setTime(100); f.pending(text); await f.service.tick();
  assert.equal(calls, 1); assert.equal(f.engine.snapshot().equipment.top3[0].messageVotes, 1);
  assert.equal(f.service.snapshot().equipmentPolicy.status, 'no-candidates');
  assert.match(f.service.snapshot().equipmentPolicy.message, /歧义原词/);
  assert.deepEqual(f.engine.snapshot().equipment.unknown, []);
  f.service.cache.set(JSON.stringify([f.service.model, 'equipment', text, null]), fields(['无尽之刃']));
  f.setTime(200); f.pending(text); await f.service.tick();
  assert.equal(calls, 1); assert.equal(f.service.snapshot().equipmentPolicy.cacheHits, 0);
  assert.equal(f.engine.snapshot().equipment.top3[0].messageVotes, 1);
  f.setTime(300); f.pending(text); await f.service.tick();
  assert.equal(f.engine.snapshot().pendingCount, 3);
  assert.equal(f.engine.snapshot().equipment.unknown.some(item => item.term === '大穿' && item.messageMentions === 3), true);
});

test('真实历史长句的大穿与无尽混合建议整条保留，不请求模型或漏项填首选', async () => {
  const text = '梦魇伤害靠平a，直接大穿+无尽，打起来先等塔姆上了你再飞后排';
  let calls = 0;
  const f = fixture(async (_url, request) => {
    calls++;
    return response(readUser(request).cases.map(item => ({id: item.id, ...fields(['无尽之刃'])})));
  });
  for (let index = 0; index < 3; index++) {
    f.setTime(index * 100); f.pending(text); await f.service.tick();
    assert.equal(calls, 0);
    assert.equal(f.service.snapshot().roundRequests, 0);
    assert.equal(f.engine.snapshot().validMessages, 0);
    assert.deepEqual(f.engine.snapshot().equipment.top3, []);
  }
  const state = f.engine.snapshot();
  assert.equal(state.pendingCount, 3);
  assert.equal(state.equipment.unknown.some(item => item.term === '大穿' && item.messageMentions === 3), true);
  assert.equal(f.service.snapshot().equipmentPolicy.status, 'no-candidates');
  assert.equal(f.service.snapshot().enabled, true);
  assert.equal(f.service.snapshot().costUnknown, false);
});

test('同批同文合并，独立弹幕票保留；再次同文通过本轮缓存立即回填', async () => {
  let calls = 0; let cases;
  const f = fixture(async (_url, request) => {
    calls++; cases = readUser(request).cases;
    return response(cases.map(item => ({id: item.id, ...fields([HAT])})));
  });
  f.pending('帽子不香吗', 'a'); f.pending('帽子不香吗', 'b'); f.pending('帽子不香吗');
  await f.service.tick();
  assert.equal(calls, 1); assert.equal(cases.length, 1);
  assert.equal(f.engine.snapshot().equipment.top3[0].messageVotes, 3);
  assert.equal(f.service.snapshot().equipmentPolicy.countedCount, 3);
  f.setTime(100); f.pending('帽子不香吗', 'c'); await f.service.tick();
  assert.equal(calls, 1); assert.equal(f.service.snapshot().roundRequests, 1);
  assert.equal(f.engine.snapshot().equipment.top3[0].messageVotes, 4);
  assert.equal(f.service.snapshot().equipmentPolicy.cacheHits, 1);
  assert.equal(f.service.snapshot().equipmentPolicy.appliedCount, 4);
});

test('缓存复用仍保留匿名最新改口和独立身份，不能恢复旧匿名支持', async () => {
  let calls = 0;
  const f = fixture(async (_url, request) => {calls++; return response(readUser(request).cases.map(item => ({id: item.id, ...fields([HAT])})));}, {counting: 'anonymous'});
  f.pending('帽子不香吗', 'a'); f.pending('帽子不香吗', 'b'); await f.service.tick();
  assert.equal(f.engine.snapshot().equipment.top3[0].votes, 2);
  f.setTime(100); f.pending('帽子不香吗', 'a'); f.send('金身', 'a');
  f.pending('帽子不香吗', 'c'); await f.service.tick();
  assert.equal(calls, 1);
  const result = f.engine.snapshot().equipment.top3;
  assert.equal(result.find(item => item.name === HAT).votes, 2);
  assert.equal(result.find(item => item.name === GOLD).votes, 1);
  assert.equal(result.find(item => item.name === HAT).messageVotes, 3);
});

test('不确定解释同样缓存，避免相同未决原文反复花请求', async () => {
  let calls = 0;
  const f = fixture(async (_url, request) => {calls++; return uncertainResponse(request);});
  f.pending(); await f.service.tick();
  f.setTime(200); f.pending(); await f.service.tick();
  f.setTime(8000); f.pending(); await f.service.tick();
  assert.equal(calls, 1); assert.equal(f.service.snapshot().equipmentPolicy.cacheHits, 2);
  assert.equal(f.service.snapshot().equipmentPolicy.unresolvedCount, 3);
  assert.equal(f.engine.snapshot().validMessages, 0);
  assert.equal(f.engine.snapshot().pendingCount, 3);
});

test('换轮和切换模型清缓存，旧轮回包不能给新轮添加缓存或计数', async () => {
  let calls = 0;
  const f = fixture(async (_url, request) => {calls++; return uncertainResponse(request);});
  f.pending(); await f.service.tick();
  const cost = f.service.sessionReserved;
  f.engine.startRound({mode: 'equipment', seconds: 30});
  assert.equal(f.service.snapshot().roundRequests, 0);
  assert.equal(f.service.snapshot().equipmentPolicy.cacheHits, 0);
  f.pending(); await f.service.tick(); assert.equal(calls, 2);
  f.service.configure({model: 'deepseek-v4-pro'});
  f.setTime(7500); f.pending(); await f.service.tick(); assert.equal(calls, 3);
  assert.ok(f.service.sessionReserved > cost);
  let finish; let deferredCalls = 0;
  const deferred = fixture(() => {deferredCalls++; return new Promise(resolve => {finish = resolve;});});
  deferred.pending(); const working = deferred.service.tick();
  deferred.engine.startRound({mode: 'equipment', seconds: 30});
  assert.equal(deferred.service.snapshot().roundRequests, 0);
  finish(response([{id: '0', ...fields([HAT])}])); await working;
  assert.equal(deferred.service.cache.size, 0);
  assert.equal(deferred.service.snapshot().equipmentPolicy.appliedCount, 0);
  deferred.pending(); const fresh = deferred.service.tick();
  assert.equal(deferredCalls, 2);
  finish(response([{id: '0', ...fields([], [], true)}])); await fresh;
});

test('检索使用完整目录但请求仅有实际候选，未知昵称不借用相似装备', async () => {
  assert.ok(allowedEquipment().length > 300);
  const known = '公理圆弧';
  assert.ok(allowedEquipment().includes(known));
  let user;
  const f = fixture(async (_url, request) => {user = readUser(request); return response([{id: '0', ...fields([known])}]);});
  f.pending(`${known}不香吗`); await f.service.tick();
  assert.deepEqual(user.allowedItems, [known]); assert.deepEqual(user.cases[0].candidates, [known]);
  assert.equal(f.engine.snapshot().equipment.top3[0].name, known);
  assert.deepEqual(equipmentCandidates('小绿甲'), []);
});

test('完整目录合法装备也不能跨原文候选回填，五种分类都受限', async () => {
  for (const field of ['current', 'later', 'alternatives', 'against', 'conditional']) {
    const f = fixture(async () => response([{id: '0', ...fields(), [field]: [GOLD]}, {id: '1', ...fields([GOLD])}]));
    f.pending('帽子不香吗'); f.pending('金身不香吗'); await f.service.tick();
    assert.equal(f.service.snapshot().enabled, false, field);
    assert.equal(f.service.snapshot().equipmentPolicy.appliedCount, 0, field);
    assert.equal(f.engine.snapshot().validMessages, 0, field);
    assert.equal(f.service.cache.size, 0, field);
    assert.equal(f.service.snapshot().costUnknown, false, field);
  }
});

test('整批最多三种原文，合并后的每条消息仍各自校验票据', async () => {
  let cases;
  const f = fixture(async (_url, request) => {cases = readUser(request).cases; return uncertainResponse(request);});
  for (const text of ['帽子不香吗', '金身不香吗', '破败不香吗', '公理圆弧不香吗', '帽子不香吗']) f.pending(text);
  await f.service.tick();
  assert.equal(cases.length, 3);
  assert.equal(f.service.snapshot().equipmentPolicy.appliedCount, 4);
  assert.equal(f.engine.listPending().length, 1);
});

test('请求保留原始全文、拒绝重定向；公开状态没有原文和认证值', async () => {
  const text = '帽子' + '讨论'.repeat(100) + '先别出帽子？';
  const f = fixture(async (url, request) => {
    assert.equal(url, 'https://api.deepseek.com/chat/completions'); assert.equal(request.redirect, 'error');
    const body = JSON.parse(request.body);
    assert.equal(body.thinking.type, 'disabled'); assert.equal(body.response_format.type, 'json_object');
    assert.equal(body.max_tokens, 512); assert.equal(readUser(request).cases[0].text, text);
    return uncertainResponse(request);
  });
  f.pending(text); await f.service.tick();
  const publicState = JSON.stringify(f.service.snapshot());
  assert.equal(publicState.includes(text), false); assert.equal(publicState.includes('mock-only'), false);
});

test('可核对的迟到和改口计数分开，晚回包仍记录已知费用', async () => {
  for (const change of ['late', 'revision']) {
    let finish; const f = fixture(() => new Promise(resolve => {finish = resolve;}));
    f.pending('帽子不香吗', 'a'); const working = f.service.tick();
    if (change === 'late') f.setTime(5000); else f.send('金身', 'a');
    finish(response([{id: '0', ...fields([HAT])}])); await working;
    const policy = f.service.snapshot().equipmentPolicy;
    assert.equal(policy.discardedCount, 1, change);
    assert.equal(policy.lateCount, change === 'late' ? 1 : 0, change);
    assert.equal(policy.countedCount, 0, change);
    assert.equal(f.service.snapshot().estimatedPeakCostCny, 0.00028, change);
  }
});

test('单条建议剩余处理期限不足时不发起请求，精确一千二百毫秒仍可请求', async () => {
  for (const [at, callsExpected] of [[3800, 1], [3801, 0]]) {
    let calls = 0;
    const f = fixture(async (_url, request) => {calls++; return uncertainResponse(request);});
    f.pending(); f.setTime(at); await f.service.tick();
    assert.equal(calls, callsExpected); assert.equal(f.engine.tickets.size, 0);
  }
});

test('费用预算与次数预算分别解释，新轮不继承旧轮错误，缓存仍可复用', async () => {
  for (const [field, value, status] of [['roundReserved', 0.099999, 'round-cost'], ['sessionReserved', 0.999999, 'session-cost']]) {
    const f = fixture(async (_url, request) => uncertainResponse(request));
    f.service.snapshot(); f.service[field] = value; f.pending(); await f.service.tick();
    assert.equal(f.service.snapshot().equipmentPolicy.status, status);
    assert.match(f.service.snapshot().error, /金额预算/);
    assert.equal(f.service.snapshot().roundRequests, 0);
    if (status === 'round-cost') {
      f.engine.startRound({mode: 'equipment', seconds: 30});
      assert.equal(f.service.snapshot().error, ''); assert.equal(f.service.snapshot().roundRequests, 0);
    }
  }
  let calls = 0;
  const f = fixture(async (_url, request) => {calls++; return response(readUser(request).cases.map(item => ({id: item.id, ...fields([HAT])})));});
  f.pending(); await f.service.tick();
  f.service.roundRequests = 4; f.pending(); await f.service.tick();
  assert.equal(calls, 1); assert.equal(f.engine.snapshot().validMessages, 2);
  assert.equal(f.service.snapshot().equipmentPolicy.cacheHits, 1);
});

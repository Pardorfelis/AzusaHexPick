import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PanelEngine } from '../src/engine.mjs';
import { allowedEquipment, classifyEquipment, validateInterpretation } from '../src/equipment.mjs';

const HAT = '灭世者的死亡之帽';
const GOLD = '中娅沙漏';
const VOID = '虚空之杖';
const json = path => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const interpretation = current => ({ current: current ? [current] : [], later: [], alternatives: [], against: [], conditional: [], uncertain: false });
const votes = (engine, key) => engine.snapshot().hex.find(item => item.key === key);

function fixture(options = {}, round = {}) {
  let time = 0;
  const engine = new PanelEngine({ now: () => time, ...options });
  engine.setConnection('connected', 'test:1');
  engine.startRound({ seconds: 30, ...round });
  return { engine, setTime(value) { time = value; }, send(id, text, anonymousId = null, extra = {}) {
    return engine.ingest({ id, text, anonymousId, at: time, source: 'test:1', ...extra });
  } };
}

test('默认使用弹幕条数，原六项加完整刷新动作，匿名口径明确标为实验', () => {
  const { engine } = fixture();
  assert.equal(engine.snapshot().counting, 'messages');
  assert.deepEqual(engine.snapshot().hex.map(item => item.key), ['1', '2', '3', '1d', '2d', '3d', 'd', '12d', '13d', '23d']);
  engine.startRound({ counting: 'anonymous' });
  assert.match(engine.snapshot().countingLabel, /匿名标识.*实验/);
});

test('六指令、重复数字与明确短句归并，数字闲聊不误计', () => {
  const { engine, send } = fixture();
  for (const [id, value] of ['1', ' 2 ', '3', '１Ｄ', '2D', '3d', '111', '1厉害'].entries()) send(`valid:${id}`, value);
  for (const [id, value] of ['321', '2w', '13', '1d2', 'choose 2', '2秒', '23都行', ''].entries()) send(`chat:${id}`, value);
  assert.deepEqual(engine.snapshot().hex.map(item => item.messageVotes), [3, 1, 1, 1, 1, 1, 0, 0, 0, 0]);
});

test('缺失匿名身份与 UID 为 0 的消息不会合并为一个人', () => {
  const { engine, send } = fixture({}, { counting: 'anonymous' });
  send('m1', '1', null, { uid: 0 });
  send('m2', '2', '', { uid: 0 });
  assert.equal(votes(engine, '1').messageVotes, 1);
  assert.equal(votes(engine, '2').messageVotes, 1);
  assert.equal(engine.snapshot().hex.reduce((sum, item) => sum + item.anonymousVotes, 0), 0);
  assert.equal(engine.snapshot().missingIdentityMessages, 2);
});

test('匿名最新有效票会替换，条数仍累计，无关聊天不撤票', () => {
  const { engine, send } = fixture({}, { counting: 'anonymous' });
  send('m1', '1', 'a'); send('m2', '1', 'a'); send('m3', '3d', 'a'); send('m4', '哈哈', 'a');
  assert.equal(votes(engine, '1').messageVotes, 2);
  assert.equal(votes(engine, '1').anonymousVotes, 0);
  assert.equal(votes(engine, '3d').anonymousVotes, 1);
});

test('消息去重跨轮保留，缓存有界，超出缓存不承诺永久去重', () => {
  const { engine, send } = fixture({ dedupLimit: 2 });
  send('m1', '1'); send('m2', '2');
  engine.startRound();
  assert.equal(send('m2', '2').ignoredReason, 'duplicate-message');
  send('m3', '3');
  assert.equal(engine.snapshot().dedupEntries, 2);
  assert.equal(send('m1', '1').accepted, true);
  assert.equal(engine.snapshot().dedupEntries, 2);
});

test('断连暂停，恢复开启新轮，旧来源消息不进入结果', () => {
  const { engine, send } = fixture();
  send('m1', '1', 'a');
  const before = engine.snapshot().roundId;
  engine.setConnection('disconnected');
  assert.equal(send('m2', '2').accepted, false);
  assert.equal(engine.snapshot().status, 'paused');
  engine.setConnection('connected', 'test:2');
  assert.equal(engine.snapshot().roundId, before + 1);
  assert.equal(engine.snapshot().hex.reduce((sum, item) => sum + item.votes, 0), 0);
  assert.equal(send('m3', '3').ignoredReason, 'old-source');
  assert.equal(engine.ingest({ id: 'm4', text: '2', source: 'test:2', at: 0 }).accepted, true);
});

test('手动锁定与截止时间均阻止后续消息和 AI 结果', () => {
  const manual = fixture({}, { mode: 'equipment' });
  manual.send('m1', '出陌生装备', 'a');
  const ticket = manual.engine.createAiTicket('m1');
  manual.engine.lockRound();
  assert.equal(manual.send('m2', '帽子').accepted, false);
  assert.equal(manual.engine.applyAi(ticket, interpretation(HAT)), false);
  const timed = fixture({}, { seconds: 1 });
  timed.send('early', '1'); timed.setTime(1000);
  assert.equal(timed.send('late', '2').accepted, false);
  assert.equal(timed.engine.snapshot().lockReason, 'timeout');
});

test('旧画面纯数字新消息仍可能混入，清零没有解决视频延迟', () => {
  const { engine, send } = fixture();
  send('old', '1'); engine.startRound(); send('new-id-old-picture', '3');
  assert.equal(votes(engine, '3').votes, 1);
  assert.match(engine.snapshot().limitations[0], /旧画面/);
});

test('装备支持与反对分开，后续、条件及备选不计首选', () => {
  const { engine, send } = fixture({}, { mode: 'equipment' });
  send('m1', '别出帽子，出金身', 'a');
  send('m2', '先金身，再帽子', 'b');
  send('m3', '帽子或者法穿棒', 'c');
  send('m4', '有钱就帽子', 'd');
  assert.deepEqual(engine.snapshot().equipment.top3.map(item => [item.name, item.votes]), [[GOLD, 2]]);
  assert.deepEqual(engine.snapshot().equipment.against.map(item => [item.name, item.votes]), [[HAT, 1]]);
});

test('普通聊天和机制讨论忽略，陌生装备建议与复杂多装备进入待识别', () => {
  const { engine, send } = fixture({}, { mode: 'equipment' });
  for (const [id, text] of ['今天真好', '哈哈哈', 'q能附带破败特效', '破败被动伤害很高', '好高的帽子'].entries()) {
    assert.equal(send(`chat:${id}`, text).pending, false);
  }
  assert.equal(send('unknown', '出陌生装备').pending, true);
  assert.equal(send('complex', '出帽子金身').pending, true);
  assert.equal(engine.snapshot().pendingCount, 2);
  assert.deepEqual(engine.snapshot().equipment.top3, []);
});

test('旧轮、旧来源及过期 AI 任务不能写入', () => {
  for (const transition of ['round', 'connection', 'timeout']) {
    const { engine, send, setTime } = fixture({ aiTimeoutMs: 100 }, { mode: 'equipment' });
    send('m1', '出陌生装备', 'a');
    const ticket = engine.createAiTicket('m1');
    if (transition === 'round') engine.startRound();
    else if (transition === 'connection') { engine.setConnection('disconnected'); engine.setConnection('connected', 'test:2'); }
    else setTime(101);
    assert.equal(engine.applyAi(ticket, interpretation(HAT)), false);
    assert.deepEqual(engine.snapshot().equipment.top3, []);
  }
});

test('同人新 AI 请求和本地明确建议都使旧任务失效', () => {
  for (const replacement of ['出另一件陌生装备', '金身']) {
    const { engine, send } = fixture({}, { mode: 'equipment', counting: 'anonymous' });
    send('old', '出陌生装备', 'a');
    const ticket = engine.createAiTicket('old');
    send('new', replacement, 'a');
    assert.equal(engine.applyAi(ticket, interpretation(HAT)), false);
    assert.equal(engine.snapshot().equipment.top3.some(item => item.name === HAT), false);
    if (replacement === '金身') assert.equal(engine.snapshot().equipment.top3[0].name, GOLD);
  }
});

test('新建议移除旧匿名 AI 展示，普通聊天保留已确认建议', () => {
  const { engine, send } = fixture({}, { mode: 'equipment', counting: 'anonymous' });
  send('m1', '出陌生装备', 'a');
  assert.equal(engine.applyAi(engine.createAiTicket('m1'), interpretation(HAT)), true);
  send('chat', '今天真好', 'a');
  assert.equal(engine.snapshot().equipment.top3[0].name, HAT);
  send('m2', '出另一件陌生装备', 'a');
  assert.deepEqual(engine.snapshot().equipment.top3, []);
});

test('待识别记录与匿名参与者容量有界，被淘汰任务不可返回', () => {
  const { engine, send } = fixture({ maxRecords: 2, maxParticipants: 1 }, { mode: 'equipment', counting: 'anonymous' });
  send('m1', '出陌生装备', 'a');
  const ticket = engine.createAiTicket('m1');
  send('m2', '金身', 'b'); send('m3', '帽子', 'c');
  assert.equal(engine.records.size, 2);
  assert.equal(engine.applyAi(ticket, interpretation(HAT)), false);
  assert.equal(engine.snapshot().capacityLimited, true);
  assert.equal(engine.snapshot().evictedPending, 1);
  assert.deepEqual(engine.snapshot().equipment.top3, []);
});

test('AI 解释必须完整，拒绝额外操作字段、未知装备与冲突结果', () => {
  assert.equal(validateInterpretation({ current: [HAT] }), null);
  assert.equal(validateInterpretation({ ...interpretation(HAT), command: 'change-counts' }), null);
  assert.equal(validateInterpretation(interpretation('不存在的装备')), null);
  assert.equal(validateInterpretation({ ...interpretation(HAT), against: [HAT] }), null);
  assert.equal(validateInterpretation({ ...interpretation(HAT), uncertain: true }), null);
  assert.deepEqual(validateInterpretation(interpretation(GOLD)).current, [GOLD]);
});

test('24 条合成样例中明确规则保留语义，反问和类别描述继续待识别', () => {
  const cases = json('../validation/equipment-language-cases.json').cases;
  const byId = new Map(cases.map(item => [item.id, classifyEquipment(item.text, item.context)]));
  for (const [id, name] of [[1, HAT], [2, GOLD], [3, GOLD], [4, VOID], [5, '无尽之刃'], [10, GOLD], [18, HAT], [24, GOLD]]) {
    assert.deepEqual(byId.get(id).current, [name]);
  }
  assert.deepEqual(byId.get(6).against, [HAT]);
  assert.deepEqual(byId.get(7).later, [HAT]);
  assert.deepEqual(byId.get(8).alternatives, [HAT, VOID]);
  assert.deepEqual(byId.get(9).conditional, [GOLD]);
  assert.equal(byId.get(12).pending, true);
  assert.equal(byId.get(14).pending, true);
  for (const id of [13, 19, 20, 21, 22]) assert.equal(byId.get(id).recognized, false);
});

test('扩展装备正式名存在于已保存的官方资料，真实别名可归并', () => {
  const official = new Set(json('../data/riot-equipment-names.json').names);
  assert.ok(allowedEquipment().length > 350);
  for (const name of allowedEquipment()) assert.equal(official.has(name), true, name);
  for (const [alias, name] of [['冰杖', '瑞莱的冰晶节杖'], ['破败', '破败王者之刃'], ['卢登', '卢登的回声'],
    ['大天使', '大天使之杖'], ['魔切', '魔切'], ['影烟', '影焰'], ['影炎', '影焰'], ['饮血', '饮血剑'], ['心之刚', '心之钢']]) {
    assert.deepEqual(classifyEquipment(alias).current, [name]);
  }
});

test('用户提供的 P3 指定 10 秒片段，两种口径与人工核对一致', () => {
  const data = json('../data/replays/azusa-p3.json');
  const rows = data.messages.filter(item => item.at >= 1480 && item.at < 1490);
  for (const counting of ['messages', 'anonymous']) {
    const { engine, setTime } = fixture({}, { counting, seconds: 10 });
    for (const row of rows) {
      setTime((row.at - 1480) * 1000);
      engine.ingest({ ...row, at: (row.at - 1480) * 1000, source: 'test:1' });
    }
    assert.equal(votes(engine, '1').votes, counting === 'messages' ? 12 : 11);
    assert.equal(votes(engine, '2').votes, counting === 'messages' ? 22 : 20);
    assert.equal(votes(engine, '3').votes, 1);
  }
});

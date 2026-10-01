import test from 'node:test';
import assert from 'node:assert/strict';
import { PanelEngine } from '../src/engine.mjs';

function fixture(options = {}) {
  let now = 0;
  let sequence = 0;
  const engine = new PanelEngine({ now: () => now, ...options });
  engine.setConnection('connected', 'source');
  engine.startRound({ mode: 'equipment', seconds: 60 });
  return { engine, advance(value) { now = value; }, send(text, anonymousId = null) {
    return engine.ingest({ id: 'm' + ++sequence, text, anonymousId, at: now, source: 'source' });
  } };
}

test('用户指出的绿甲与蓝盾现在直接支持确定装备，不消耗模型任务', () => {
  const f = fixture();
  for (const text of ['绿甲', '出绿甲', '蓝盾', '出蓝盾']) assert.equal(f.send(text).pending, false);
  const snapshot = f.engine.snapshot();
  assert.equal(snapshot.validMessages, 4);
  assert.deepEqual(snapshot.equipment.top3.map(item => [item.name, item.votes]), [['兰顿之兆', 2], ['振奋盔甲', 2]]);
  assert.equal(snapshot.equipmentDiagnostics.byTier.local, 4);
  assert.equal(f.engine.listPending().length, 0);
});

test('重复陌生装备词单独展示，不能成为确定票或首选', () => {
  const f = fixture();
  f.send('直接出蓝甲', 'a'); f.send('蓝甲', 'b');
  assert.deepEqual(f.engine.snapshot().equipment.unknown, []);
  f.send('出蓝甲', 'c');
  const snapshot = f.engine.snapshot();
  assert.deepEqual(snapshot.equipment.unknown, [{term:'蓝甲', messageMentions:3, anonymousMentions:3, mentions:3}]);
  assert.equal(snapshot.validMessages, 0);
  assert.deepEqual(snapshot.equipment.top3, []);
  assert.equal(JSON.stringify(snapshot).includes('直接出蓝甲'), false);
  assert.equal(JSON.stringify(snapshot).includes('anonymous:'), false);
});

test('改口、AI 确认、新轮与记录淘汰会移除旧待确认线索', () => {
  const f = fixture();
  for (const id of ['a','b','c']) f.send('蓝甲', id);
  assert.equal(f.engine.snapshot().equipment.unknown.length, 1);
  f.send('绿甲', 'a');
  assert.deepEqual(f.engine.snapshot().equipment.unknown, []);
  assert.equal(f.engine.snapshot().equipment.top3[0].name, '振奋盔甲');
  assert.equal(f.engine.equipmentAudit().samples.find(row => row.messageKey === 'm1').reason, 'superseded');
  f.engine.startRound();
  assert.deepEqual(f.engine.snapshot().equipment.unknown, []);
  assert.deepEqual(f.engine.equipmentAudit().samples, []);
  const bounded = fixture({ maxRecords: 2 });
  for (const id of ['a','b','c']) bounded.send('蓝甲', id);
  assert.equal(bounded.engine.records.size, 2);
  assert.deepEqual(bounded.engine.snapshot().equipment.unknown, []);
});

test('匿名口径的陌生词提及数采用不同标识，反对和闲聊不形成候选', () => {
  const f = fixture();
  f.engine.startRound({ counting: 'anonymous' });
  f.send('蓝甲', 'a'); f.send('蓝甲', 'a'); f.send('蓝甲', 'b');
  assert.deepEqual(f.engine.snapshot().equipment.unknown, []);
  for (const text of ['别出蓝甲', '蓝甲有用吗', '蓝甲触发的伤害', '装备没问题']) f.send(text, 'x');
  assert.deepEqual(f.engine.snapshot().equipment.unknown, []);
  f.send('蓝甲', 'c');
  assert.equal(f.engine.snapshot().equipment.unknown[0].mentions, 3);
  assert.equal(f.engine.snapshot().equipment.unknown[0].anonymousMentions, 3);
});

test('过期的前排未决不会阻塞新表达，原文样本只在本机审计返回', () => {
  const f = fixture();
  for (let index = 0; index < 105; index++) f.send('出蓝甲');
  f.advance(5001);
  const fresh = f.send('帽子不香吗');
  assert.deepEqual(f.engine.listPending().map(row => row.messageKey), [fresh.messageKey]);
  const audit = f.engine.equipmentAudit();
  assert.equal(audit.samples.length, 20);
  audit.samples.at(-1).current.push('changed');
  assert.deepEqual(f.engine.equipmentAudit().samples.at(-1).current, []);
  assert.equal(JSON.stringify(f.engine.snapshot()).includes('帽子不香吗'), false);
});

test('装备 AI 回填计入单条与分类来源统计，跨轮任务不再采用', () => {
  const f = fixture();
  const row = f.send('绿甲还是蓝盾', 'a');
  assert.equal(row.pending, true);
  const ticket = f.engine.createAiTicket(row.messageKey);
  const interpretation = {current:['振奋盔甲'], against:[], later:[], alternatives:[], conditional:[], uncertain:false};
  assert.equal(f.engine.applyAi(ticket, interpretation), true);
  assert.equal(f.engine.snapshot().validMessages, 1);
  assert.deepEqual(f.engine.snapshot().equipmentDiagnostics.byTier, {local:0, ai:1});
  assert.equal(f.engine.equipmentAudit().samples.at(-1).via, 'ai');
  f.engine.startRound();
  assert.equal(f.engine.applyAi(ticket, interpretation), false);
  assert.equal(f.engine.snapshot().validMessages, 0);
});

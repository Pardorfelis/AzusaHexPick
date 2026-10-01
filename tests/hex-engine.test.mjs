import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PanelEngine, HEX_AI_MIN_LOCAL_VOTES } from '../src/engine.mjs';

function fixture(options = {}, round = {}) {
  let time = 0;
  const engine = new PanelEngine({ now: () => time, ...options });
  engine.setConnection('connected', 'hex:test');
  engine.startRound({ mode: 'hex', seconds: 30, ...round });
  return { engine, time: value => { time = value; },
    send: (id, text, anonymousId = null) => engine.ingest({ id, text, anonymousId, at: time, source: engine.source }) };
}
const vote = (engine, key) => engine.snapshot().hex.find(row => row.key === key);

test('刷屏每消息一票，识别来源可核对，拒绝消息不计票', () => {
  const { engine, send } = fixture();
  send('one', '2'); send('repeat', '222222222222'); send('phrase', '必须2');
  send('negative', '别选2'); send('multiple', '23都行'); send('ordinary', '2秒');
  send('repeat', '222222222222');
  const state = engine.snapshot();
  assert.equal(state.receivedMessages, 6);
  assert.equal(state.validMessages, 3);
  assert.equal(vote(engine, '2').votes, 3);
  assert.deepEqual(state.hexDiagnostics.byTier, { exact: 1, repeated: 1, phrase: 1, ai: 0 });
  assert.equal(state.hexDiagnostics.localVotes, 3);
  assert.equal(state.hexDiagnostics.ignoredByReason.against, 1);
  assert.equal(state.hexDiagnostics.ignoredByReason.multi, 1);
});

test('匿名最新口径与累计有效消息分别展示，明确改口使旧未决任务失效', () => {
  const { engine, send } = fixture({}, { counting: 'anonymous' });
  send('one', '111', 'same'); send('two', '直接拿2啊', 'same');
  send('pending', '2收集者', 'same');
  const ticket = engine.createAiTicket('pending');
  send('three', '必须3', 'same');
  assert.equal(engine.applyAi(ticket, { command: '2', uncertain: false }), false);
  assert.equal(engine.snapshot().validMessages, 3);
  assert.equal(vote(engine, '3').votes, 1);
  assert.equal(engine.snapshot().hex.reduce((sum, row) => sum + row.votes, 0), 1);
  assert.equal(engine.snapshot().pendingCount, 0);
});

test('海克斯 AI 只能确认文本已有编号，不能生成票数或不同选项', () => {
  const { engine, send } = fixture();
  send('pending', '2然后收集者', 'a');
  const record = engine.listPending()[0];
  assert.equal(record.candidate, '2');
  assert.equal(engine.applyAi(engine.createAiTicket('pending'), { command: '3', uncertain: false }), false);
  assert.equal(engine.snapshot().validMessages, 0);
  send('next', '2收集者', 'b');
  assert.equal(engine.applyAi(engine.createAiTicket('next'), { command: '2', uncertain: false }), true);
  assert.equal(vote(engine, '2').votes, 1);
  assert.equal(engine.snapshot().hexDiagnostics.aiVotes, 1);
  assert.equal(engine.applyAi({ id: 2 }, { command: '2', uncertain: false }), false);
  assert.equal(vote(engine, '2').votes, 1);
});

test('明确建议达到调用阈值后不应用在途复杂解释，阈值不是置信度', () => {
  const { engine, send } = fixture();
  send('pending', '2收集者', 'a');
  const ticket = engine.createAiTicket('pending');
  for (let index = 0; index < HEX_AI_MIN_LOCAL_VOTES; index++) send('local:' + index, '1', 'b');
  assert.equal(engine.applyAi(ticket, { command: '2', uncertain: false }), false);
  assert.equal(vote(engine, '2').votes, 0);
  assert.equal(engine.snapshot().validMessages, HEX_AI_MIN_LOCAL_VOTES);
});

test('海克斯未决结果隔离旧轮、旧来源、截止和过期', () => {
  for (const transition of ['round', 'source', 'deadline', 'expired', 'expiry-boundary']) {
    const { engine, send, time } = fixture({ aiTimeoutMs: 100 }, { seconds: 1 });
    send('pending', '2收集者', 'a');
    const ticket = engine.createAiTicket('pending');
    if (transition === 'round') engine.startRound();
    if (transition === 'source') engine.setConnection('connected', 'new-source');
    if (transition === 'deadline') time(1000);
    if (transition === 'expired') time(101);
    if (transition === 'expiry-boundary') time(100);
    assert.equal(engine.applyAi(ticket, { command: '2', uncertain: false }), false);
    assert.equal(vote(engine, '2').votes, 0);
  }
});

test('明确反对撤回匿名支持并使旧解释失效，消息历史保持原计数', () => {
  const { engine, send } = fixture({}, { counting: 'anonymous' });
  send('clear', '2', 'a');
  send('pending', '2收集者', 'a');
  const ticket = engine.createAiTicket('pending');
  send('withdraw', '别选2', 'a');
  assert.equal(engine.applyAi(ticket, { command: '2', uncertain: false }), false);
  assert.equal(vote(engine, '2').votes, 0);
  assert.equal(vote(engine, '2').messageVotes, 1);
  assert.equal(engine.snapshot().validMessages, 1);
});

test('缺身份未决记录不占匿名参与者容量', () => {
  const { engine, send } = fixture({ maxParticipants: 1 });
  send('unidentified', '2收集者');
  send('identified', '1', 'first-real-anonymous');
  assert.equal(vote(engine, '1').anonymousVotes, 1);
  assert.equal(engine.snapshot().capacityLimited, false);
  assert.equal(engine.anonymousParticipants.size, 1);
});

test('无身份明确消息不积累修订记录，未决记录与识别样本有界', () => {
  const { engine, send } = fixture({ maxRecords: 2, dedupLimit: 5 });
  for (let index = 0; index < 100; index++) send('clear:' + index, '222');
  assert.equal(engine.records.size, 0);
  assert.equal(engine.revisions.size, 0);
  assert.equal(engine.hexAudit().samples.length, 20);
  for (let index = 0; index < 3; index++) send('pending:' + index, '2收集者');
  assert.equal(engine.records.size, 2);
  assert.equal(engine.revisions.size, 2);
  assert.equal(engine.snapshot().evictedPending, 1);
});

test('原文识别样本只走专用接口，不进入共享快照，换轮清空', () => {
  const { engine, send } = fixture();
  send('sample', '直接拿2啊', 'private-anonymous-id');
  const shared = JSON.stringify(engine.snapshot());
  assert.equal(shared.includes('直接拿2啊'), false);
  assert.equal(shared.includes('private-anonymous-id'), false);
  const audit = engine.hexAudit();
  assert.equal(audit.samples[0].command, '2');
  audit.samples[0].command = '1';
  assert.equal(engine.hexAudit().samples[0].command, '2');
  engine.startRound();
  assert.equal(engine.hexAudit().samples.length, 0);
});

test('用户报告的 P3 三十秒与六十秒窗口，扩展后计数符合独立复核', () => {
  const data = JSON.parse(readFileSync(new URL('../data/replays/azusa-p3.json', import.meta.url), 'utf8'));
  for (const [seconds, received, expected] of [[30, 94, [9, 44, 10, 1, 0, 0, 0, 0, 0, 0]], [60, 150, [12, 64, 11, 2, 0, 0, 1, 0, 0, 0]]]) {
    const { engine, time } = fixture({}, { seconds });
    for (const row of data.messages.filter(row => row.at >= 6830 && row.at < 6830 + seconds)) {
      time((row.at - 6830) * 1000);
      engine.ingest({ ...row, at: (row.at - 6830) * 1000, replayAt: row.at, source: engine.source });
    }
    time(seconds * 1000);
    const state = engine.snapshot();
    assert.equal(state.receivedMessages, received);
    assert.deepEqual(state.hex.map(row => row.messageVotes), expected);
    assert.equal(state.validMessages, expected.reduce((sum, value) => sum + value, 0));
    assert.equal(state.status, 'locked');
  }
});

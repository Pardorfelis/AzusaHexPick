import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { ReplaySource } from '../src/replay-source.mjs';
import { PanelEngine } from '../src/engine.mjs';

const directory = fileURLToPath(new URL('../data/replays/', import.meta.url));

function fixture() {
  let time = 1700000000000;
  const messages = [];
  const statuses = [];
  const engine = new PanelEngine({ now: () => time });
  engine.startRound({ seconds: 30 });
  const replay = new ReplaySource({ directory, now: () => time,
    onMessage(message) { messages.push(message); engine.ingest(message); },
    onStatus(status) {
      statuses.push(status);
      engine.setConnection(status.state === 'playing' ? 'connected' : 'disconnected', `replay:${status.generation}`);
    },
  });
  return { replay, engine, messages, statuses, advance(milliseconds) { time += milliseconds; }, now: () => time };
}

test('加载和定位暂停，播放使用毫秒接收时间并保留秒单位回放位置', async t => {
  const f = fixture(); t.after(() => f.replay.stop());
  await f.replay.load('azusa-p3', 1480, 1);
  assert.equal(f.replay.snapshot().state, 'paused');
  assert.equal(f.replay.snapshot().position, 1480);
  f.replay.play(); f.advance(800); f.replay.tick();
  assert.equal(f.messages.length, 2);
  assert.equal(f.messages[0].replayAt, 1480.296);
  assert.equal(f.messages[0].at, f.now());
  assert.match(f.messages[0].source, /^replay:\d+$/);
  assert.equal(f.engine.snapshot().hex.find(item => item.key === '1').votes, 1);
});

test('暂停冻结位置且不发消息，恢复后延续同一回放代际', async t => {
  const f = fixture(); t.after(() => f.replay.stop());
  await f.replay.load('azusa-p3', 1480, 1);
  f.replay.play(); f.advance(800); f.replay.tick(); f.replay.pause();
  const generation = f.replay.generation;
  const position = f.replay.snapshot().position;
  f.advance(5000); f.replay.tick();
  assert.equal(f.messages.length, 2);
  assert.equal(f.replay.snapshot().position, position);
  f.replay.play(); f.replay.tick();
  assert.equal(f.replay.generation, generation);
  assert.equal(f.messages.length, 2);
});

test('定位隔离旧轮并生成新播放消息编号，同一片段可以复测', async t => {
  const f = fixture(); t.after(() => f.replay.stop());
  await f.replay.load('azusa-p3', 1480, 1);
  f.replay.play(); f.advance(800); f.replay.tick();
  const oldMessage = f.messages[1];
  const oldRound = f.engine.snapshot().roundId;
  f.replay.seek(1480); f.replay.play();
  assert.ok(f.engine.snapshot().roundId > oldRound);
  assert.equal(f.engine.ingest(oldMessage).accepted, false);
  f.advance(800); f.replay.tick();
  assert.equal(f.messages.length, 4);
  assert.notEqual(f.messages[3].id, oldMessage.id);
  assert.notEqual(f.messages[3].source, oldMessage.source);
  assert.equal(f.engine.snapshot().hex.find(item => item.key === '1').votes, 1);
});

test('旧代际定时回调不能推进新定位', async t => {
  const f = fixture(); t.after(() => f.replay.stop());
  await f.replay.load('azusa-p3', 1480, 1);
  const oldGeneration = f.replay.generation;
  f.replay.seek(1480); f.replay.play(); f.advance(800);
  f.replay.tick(oldGeneration);
  assert.equal(f.messages.length, 0);
  f.replay.tick();
  assert.equal(f.messages.length, 2);
});

test('异步加载过程中停止，旧加载完成后不能恢复回放', async () => {
  const f = fixture();
  const loading = f.replay.load('azusa-p3');
  f.replay.stop();
  await loading;
  assert.equal(f.replay.snapshot().state, 'stopped');
  assert.equal(f.replay.snapshot().dataset, null);
  f.replay.play(); f.advance(1000); f.replay.tick();
  assert.equal(f.messages.length, 0);
});

test('播放、暂停、停止及结束状态与通知快照一致', async t => {
  const f = fixture(); t.after(() => f.replay.stop());
  await f.replay.load('azusa-p3', 7212, 1);
  for (const action of [() => f.replay.play(), () => f.replay.pause(), () => f.replay.stop()]) {
    action();
    assert.equal(f.replay.snapshot().state, f.statuses.at(-1).state);
    assert.equal(f.replay.snapshot().generation, f.statuses.at(-1).generation);
  }
  f.replay.play(); f.advance(1000); f.replay.tick();
  assert.equal(f.statuses.at(-1).state, 'ended');
  assert.equal(f.replay.snapshot().state, 'ended');
});

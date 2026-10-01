import test from 'node:test';
import assert from 'node:assert/strict';
import { PanelEngine } from '../src/engine.mjs';
import { AiService } from '../src/ai-service.mjs';
import { resolveSongTitle } from '../src/songs.mjs';

function fixture(options = {}) {
  let now = 1000;
  let serial = 0;
  const engine = new PanelEngine({ now: () => now, ...options });
  engine.setConnection('connected', 'song-fixture');
  engine.startRound({ mode: 'songs', counting: 'anonymous', seconds: 60 });
  return { engine, send: (text, extra = {}) => engine.ingest({ id: `s${++serial}`, text, anonymousId: 'same-viewer', ...extra }),
    setTime: value => { now = value; } };
}

test('点歌按消息计次，同一人反复发言都计入，传输重放仍只收一条', () => {
  const { engine, send } = fixture();
  assert.equal(engine.snapshot().counting, 'messages');
  send('普通朋友', { id: 'first' });
  assert.equal(engine.snapshot().songs.items.length, 0);
  assert.equal(engine.snapshot().songs.singles.length, 0);
  assert.equal(engine.snapshot().songs.hiddenSingles, 1);
  send('普通朋友');
  send('普通朋友', { id: 'first' });
  assert.equal(engine.snapshot().songs.items[0].requests, 2);
  assert.equal(engine.snapshot().validMessages, 2);
  assert.equal(engine.snapshot().receivedMessages, 2);
  assert.equal(engine.snapshot().missingIdentityMessages, 0);
});

test('明确单次点歌保留候选，出现第二次升到主列表；句内重复只计一次', () => {
  const { engine, send } = fixture();
  send('想听普通朋友');
  assert.equal(engine.snapshot().songs.singles[0].title, '普通朋友');
  send('普通朋友普通朋友普通朋友');
  assert.equal(engine.snapshot().songs.items[0].requests, 2);
  assert.equal(engine.snapshot().songs.singles.length, 0);
  send('想听《全新验证曲目》');
  assert.equal(engine.snapshot().songs.singles[0].known, false);
  assert.equal(engine.snapshot().pendingCount, 0);
});

test('普通重复聊天不进入点歌清单，轮次和来源边界仍生效', () => {
  const { engine, send, setTime } = fixture();
  for (const text of ['哈哈哈', '上电视', '魔了', '合影', '哈哈哈']) send(text);
  assert.equal(engine.snapshot().songs.totalRequests, 0);
  send('普通朋友', { source: 'old' });
  assert.equal(engine.snapshot().receivedMessages, 5);
  engine.lockRound();
  assert.equal(send('普通朋友').accepted, false);
  engine.startRound({ mode: 'songs', seconds: 1 });
  setTime(2000);
  assert.equal(send('普通朋友').accepted, false);
});

test('灰名单即刻隐藏、跨轮持续过滤，换场清空但保留黑名单', () => {
  const { engine, send } = fixture();
  send('想听普通朋友');
  const key = engine.snapshot().songs.singles[0].key;
  const round = engine.roundId;
  engine.addSongGray(key, round);
  assert.equal(engine.snapshot().songs.singles.length, 0);
  send('普通朋友');
  assert.equal(engine.snapshot().songs.excludedRequests, 1);
  engine.startRound({ mode: 'songs', seconds: 60 });
  send('普通朋友');
  assert.equal(engine.snapshot().validMessages, 0);
  engine.songLists.addBlack('爱情讯息', 'forever');
  assert.throws(() => engine.addSongGray(key, round), /轮次已变化/);
  engine.resetSongSession();
  assert.equal(engine.status, 'idle');
  assert.equal(engine.songLists.gray.size, 0);
  assert.equal(engine.songLists.black.size, 1);
  engine.startRound({ mode: 'songs', seconds: 60 });
  send('想听普通朋友');
  assert.equal(engine.snapshot().songs.singles.length, 1);
});

test('黑名单到期后新消息恢复计数，排除期间的请求不补票', () => {
  const { engine, send, setTime } = fixture();
  engine.songLists.addBlack('普通朋友', 'week');
  send('想听普通朋友');
  assert.equal(engine.snapshot().validMessages, 0);
  setTime(1000 + 7 * 86400000);
  engine.startRound({ mode: 'songs', seconds: 60 });
  send('想听普通朋友');
  assert.equal(engine.snapshot().songs.singles[0].requests, 1);
  assert.equal(engine.snapshot().songs.blackCount, 0);
});

test('没有点歌消息时，周期快照也会自动移除到期黑名单', () => {
  const { engine, setTime } = fixture();
  engine.songLists.addBlack('普通朋友', 'week');
  assert.equal(engine.snapshot().songs.blackCount, 1);
  setTime(1000 + 7 * 86400000);
  assert.equal(engine.songMessages.size, 0);
  assert.equal(engine.snapshot().songs.blackCount, 0);
});

test('点歌歌曲数和识别样本有界，快照与审计没有观众身份', () => {
  const { engine, send } = fixture({ maxSongs: 2 });
  send('想听普通朋友');
  send('想听爱情讯息');
  send('想听说好的幸福呢');
  assert.equal(engine.snapshot().capacityLimited, true);
  assert.equal(engine.snapshot().songs.singles.length, 2);
  for (let index = 0; index < 30; index++) send('哈哈哈');
  assert.equal(engine.songAudit().samples.length, 20);
  assert.equal(JSON.stringify(engine.snapshot()).includes('same-viewer'), false);
  assert.equal(JSON.stringify(engine.songAudit()).includes('same-viewer'), false);
  assert.equal(engine.records.size, 0);
});

test('开启原有装备与海克斯 AI，也不会向模型发送点歌弹幕', async () => {
  const { engine, send } = fixture();
  const ai = new AiService({ engine, key: 'fixture-key', fetcher: () => { throw new Error('点歌模式不得调用模型。'); } });
  ai.configure({ enabled: true, hexEnabled: true });
  send('想听普通朋友');
  await ai.tick();
  assert.equal(ai.requests, 0);
  assert.equal(engine.snapshot().songs.singles[0].title, resolveSongTitle('普通朋友').title);
});

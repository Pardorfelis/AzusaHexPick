import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { SongLists, songExpiry } from '../src/song-lists.mjs';
import { resolveSongTitle } from '../src/songs.mjs';

function folder(t) {
  const base = resolve(tmpdir());
  const location = mkdtempSync(join(base, 'azusa-song-list-'));
  t.after(() => {
    if (dirname(resolve(location)) !== base || !basename(location).startsWith('azusa-song-list-')) throw new Error('测试目录超出范围。');
    rmSync(location, { recursive: true, force: true });
  });
  return location;
}

test('黑名单期限按日历计算，并处理月末及闰年', () => {
  const start = Date.parse('2024-01-31T12:00:00Z');
  assert.equal(new Date(songExpiry(start, 'month')).toISOString(), '2024-02-29T12:00:00.000Z');
  assert.equal(new Date(songExpiry(start, 'quarter')).toISOString(), '2024-04-30T12:00:00.000Z');
  assert.equal(new Date(songExpiry(start, 'half-year')).toISOString(), '2024-07-31T12:00:00.000Z');
  assert.equal(new Date(songExpiry(Date.parse('2024-02-29T12:00:00Z'), 'year')).toISOString(), '2025-02-28T12:00:00.000Z');
  assert.equal(songExpiry(start, 'week'), start + 7 * 86400000);
  assert.equal(songExpiry(start, 'forever'), null);
  assert.throws(() => songExpiry(start, 'invalid'));
  const beijingMonthEnd = Date.parse('2026-08-31T01:00:00+08:00');
  assert.equal(songExpiry(beijingMonthEnd, 'month'), Date.parse('2026-09-30T01:00:00+08:00'));
});

test('黑名单跨重启保留，灰名单仅在本场且换场清空', t => {
  const path = join(folder(t), 'black.json');
  const lists = new SongLists({ path });
  const song = resolveSongTitle('普通朋友');
  lists.addGray(song);
  lists.addBlack('说好的幸福呢', 'month');
  const session = lists.sessionId;
  lists.resetSession();
  assert.equal(lists.gray.size, 0);
  assert.notEqual(lists.sessionId, session);
  assert.equal(lists.black.size, 1);
  lists.addGray(song);
  const restored = new SongLists({ path });
  assert.equal(restored.black.size, 1);
  assert.equal(restored.gray.size, 0);
  assert.notEqual(restored.sessionId, lists.sessionId);
  assert.equal(readFileSync(path, 'utf8').includes('普通朋友'), false);
  assert.equal(restored.removeBlack(resolveSongTitle('说好的幸福呢').key), true);
  assert.equal(new SongLists({ path }).black.size, 0);
});

test('到期即解除拉黑并从持久文件删除，永久记录不删除', t => {
  let now = 1000;
  const path = join(folder(t), 'black.json');
  const lists = new SongLists({ path, now: () => now });
  const song = resolveSongTitle('普通朋友');
  lists.addBlack(song.title, 'week');
  lists.addBlack('爱情讯息', 'forever');
  now += 7 * 86400000 - 1;
  assert.equal(lists.blocked(song.key), true);
  now += 1;
  assert.equal(lists.blocked(song.key), false);
  assert.equal(lists.black.size, 1);
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).entries.length, 1);
});

test('归一后的同名记录覆盖期限，不产生重复项；返回值不泄漏可修改内部对象', () => {
  const lists = new SongLists({ now: () => 5000 });
  lists.addBlack('《普通朋友》', 'week');
  lists.addBlack(' 普通朋友 ', 'forever');
  assert.equal(lists.black.size, 1);
  const snapshot = lists.snapshot();
  snapshot.black[0].title = '篡改';
  assert.equal(lists.snapshot().black[0].title, '普通朋友');
  assert.equal(lists.snapshot().black[0].expiresAt, null);
});

test('持久文件损坏时明确拒绝启动，不静默重置黑名单', t => {
  const path = join(folder(t), 'black.json');
  writeFileSync(path, '{broken');
  assert.throws(() => new SongLists({ path }), /无法读取/);
  assert.equal(readFileSync(path, 'utf8'), '{broken');
  writeFileSync(path, JSON.stringify({ version: 1, entries: [{ key: 'bad', title: '普通朋友', term: 'forever', expiresAt: null }] }));
  assert.throws(() => new SongLists({ path }), /无效记录/);
});

test('黑名单写盘失败不伪报添加成功，过期写盘失败仍解除拦截并提示', t => {
  const location = folder(t);
  const path = join(location, 'black.json');
  let now = 1;
  const lists = new SongLists({ path, now: () => now });
  lists.addBlack('普通朋友', 'week');
  rmSync(path);
  mkdirSync(path);
  assert.throws(() => lists.addBlack('爱情讯息', 'forever'), /未能保存/);
  assert.equal(lists.black.size, 1);
  now += 7 * 86400000;
  assert.equal(lists.blocked(resolveSongTitle('普通朋友').key), false);
  assert.match(lists.snapshot().warning, /尚未保存/);
});

test('名单容量有界，无效歌名和期限不会改写名单', () => {
  const lists = new SongLists({ maxEntries: 1 });
  lists.addBlack('普通朋友', 'forever');
  assert.throws(() => lists.addBlack('爱情讯息', 'week'), /上限/);
  assert.throws(() => lists.addBlack('', 'week'), /有效歌名/);
  assert.throws(() => lists.addBlack('普通朋友', 'invalid'), /期限/);
  lists.addGray(resolveSongTitle('普通朋友'));
  assert.throws(() => lists.addGray(resolveSongTitle('爱情讯息')), /上限/);
  assert.equal(lists.black.size, 1);
});

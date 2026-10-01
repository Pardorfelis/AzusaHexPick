import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import http from 'node:http';

const root = fileURLToPath(new URL('../', import.meta.url));
const delay = ms => new Promise(done => setTimeout(done, ms));

async function emptyPort() {
  const server = net.createServer();
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const port = server.address().port;
  await new Promise(done => server.close(done));
  return port;
}

function request(port, path, payload, hostname = '127.0.0.1', headers = {}) {
  return new Promise((done, reject) => {
    const value = payload === undefined ? undefined : JSON.stringify(payload);
    const call = http.request({ hostname, port, path, method: value === undefined ? 'GET' : 'POST',
      headers: { Connection: 'close', ...(value === undefined ? {} : { 'Content-Type': 'application/json', 'X-Panel-Control': '1' }), ...headers } }, response => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', part => { text += part; });
      response.on('end', () => { let body; try { body = JSON.parse(text); } catch { body = text; }
        done({ status: response.statusCode, body }); });
    });
    call.on('error', reject);
    call.setTimeout(3000, () => call.destroy(new Error('测试请求超时。')));
    call.end(value);
  });
}

test('点歌实际 HTTP 回放、名单持久化及只读权限', { timeout: 30000 }, async t => {
  const directory = await mkdtemp(join(resolve(tmpdir()), 'azusa-song-http-'));
  const blacklist = join(directory, 'black.json');
  let child;
  let port;
  async function start() {
    port = await emptyPort();
    child = spawn(process.execPath, ['server.mjs', '--lan'], { cwd: root, windowsHide: true, stdio: 'ignore',
      env: { ...process.env, AZUSA_PORT: String(port), AZUSA_SONG_BLACKLIST_FILE: blacklist } });
    for (let index = 0; index < 100; index++) {
      if (child.exitCode !== null) throw new Error('独立点歌测试服务未启动。');
      try { if ((await request(port, '/api/health')).status === 200) return; } catch { /* 等待本测试子进程。 */ }
      await delay(30);
    }
    throw new Error('独立测试服务启动超时。');
  }
  async function stop() {
    if (!child || child.exitCode !== null) return;
    const closed = once(child, 'exit');
    await request(port, '/api/control', { action: 'shutdown' }).catch(() => {});
    await Promise.race([closed, delay(1500)]);
    if (child.exitCode === null) { child.kill(); await closed; }
  }
  const control = payload => request(port, '/api/control', payload);
  try {
    await start();
    await t.test('歌回数据列入回放，点歌强制次数且支持较长收集窗口', async () => {
      const replays = (await request(port, '/api/replays')).body;
      assert.equal(replays.some(row => row.id === 'azusa-singing-p1' && row.windows.some(window => window.mode === 'songs' && window.at === 2790)), true);
      const value = await control({ action: 'round', mode: 'songs', counting: 'anonymous', seconds: 120 });
      assert.equal(value.status, 200);
      assert.equal(value.body.counting, 'messages');
      assert.equal(value.body.seconds, 120);
      assert.equal((await control({ action: 'round', mode: 'songs', seconds: 301 })).status, 400);
    });
    let song;
    let oldRound;
    await t.test('真实歌回消息形成可点击列表，旧轮和不存在歌曲不能添加灰名单', async () => {
      assert.equal((await control({ action: 'replay-load', dataset: 'azusa-singing-p1', position: 2790, speed: 4 })).status, 200);
      await control({ action: 'replay-play', mode: 'songs', seconds: 30 });
      for (let index = 0; index < 80; index++) {
        const value = (await request(port, '/api/state')).body;
        song = [...value.songs.items, ...value.songs.singles][0];
        if (song) { oldRound = value.roundId; break; }
        await delay(50);
      }
      assert.ok(song);
      assert.equal((await control({ action: 'song-gray-add', key: song.key, roundId: oldRound - 1 })).status, 400);
      assert.equal((await control({ action: 'song-gray-add', key: 'not-on-screen', roundId: oldRound })).status, 400);
      assert.equal((await control({ action: 'song-gray-add', key: song.key, roundId: oldRound })).status, 200);
      const value = (await request(port, '/api/state')).body;
      assert.equal([...value.songs.items, ...value.songs.singles].some(row => row.key === song.key), false);
      assert.equal((await request(port, '/api/song-lists')).body.gray.some(row => row.key === song.key), true);
      const audit = (await request(port, '/api/song-audit')).body;
      assert.ok(audit.samples.length);
      assert.equal(JSON.stringify(audit).includes('anonymousId'), false);
      assert.equal(value.ai.requests, 0);
    });
    await t.test('灰名单移除校验场次，换场清空灰名单且保留黑名单', async () => {
      const before = (await request(port, '/api/song-lists')).body;
      assert.equal((await control({ action: 'song-gray-remove', key: song.key, sessionId: 'old-session' })).status, 400);
      assert.equal((await control({ action: 'song-black-add', title: '普通朋友', term: 'week' })).status, 200);
      assert.equal((await control({ action: 'song-black-add', title: '爱情讯息', term: 'forever' })).status, 200);
      assert.equal((await control({ action: 'song-black-add', title: '', term: 'forever' })).status, 400);
      const value = await control({ action: 'song-session-reset' });
      assert.equal(value.body.status, 'idle');
      const after = (await request(port, '/api/song-lists')).body;
      assert.notEqual(after.sessionId, before.sessionId);
      assert.equal(after.gray.length, 0);
      assert.equal(after.black.length, 2);
      assert.equal((await control({ action: 'song-gray-add', key: song.key, roundId: oldRound })).status, 400);
    });
    await t.test('配对手机不能读取名单审计或写入歌曲名单', async () => {
      const health = (await request(port, '/api/health')).body;
      if (!health.viewerUrls.length) { t.diagnostic('本机没有非回环 IPv4，本项网络入口未现场验证。'); return; }
      const remote = new URL(health.viewerUrls[0]);
      const query = remote.search;
      for (const path of ['/api/song-lists', '/api/song-audit'])
        assert.equal((await request(port, path + query, undefined, remote.hostname)).status, 403);
      assert.equal((await request(port, '/api/control' + query, { action: 'song-session-reset' }, remote.hostname)).status, 403);
      assert.equal((await request(port, '/api/state' + query, undefined, remote.hostname)).status, 200);
      assert.equal((await request(port, '/api/control', { action: 'song-black-add', title: '晴天', term: 'week' }, '127.0.0.1', { Origin: 'https://invalid.example' })).status, 403);
    });
    await t.test('真正重启后黑名单保留，新的歌回场次独立', async () => {
      const before = (await request(port, '/api/song-lists')).body;
      await stop();
      await start();
      const after = (await request(port, '/api/song-lists')).body;
      assert.notEqual(after.sessionId, before.sessionId);
      assert.equal(after.gray.length, 0);
      assert.equal(after.black.length, 2);
      assert.equal(JSON.parse(await readFile(blacklist, 'utf8')).entries.length, 2);
      assert.equal((await control({ action: 'song-black-remove', key: '普通朋友' })).status, 200);
      assert.equal((await request(port, '/api/song-lists')).body.black.length, 1);
    });
  } finally {
    await stop();
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith('azusa-song-http-')) throw new Error('临时目录超出范围。');
    await rm(directory, { recursive: true, force: true });
  }
});

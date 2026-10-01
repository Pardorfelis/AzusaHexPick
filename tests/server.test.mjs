import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const delay = milliseconds => new Promise(resolveDelay => setTimeout(resolveDelay, milliseconds));

async function emptyPort() {
  const server = net.createServer();
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const port = server.address().port;
  await new Promise(resolveClose => server.close(resolveClose));
  return port === 5178 ? emptyPort() : port;
}

function request(port, path, { hostname = '127.0.0.1', method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolveResponse, reject) => {
    const req = http.request({ hostname, port, path, method,
      headers: { Connection: 'close', ...headers } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolveResponse({ status: response.statusCode,
        headers: response.headers, text: Buffer.concat(chunks).toString('utf8') }));
      response.on('error', () => reject(new Error('测试响应读取失败。')));
    });
    req.on('error', () => reject(new Error('测试连接失败。')));
    req.setTimeout(3000, () => req.destroy());
    req.end(body);
  });
}

function parsed(response) {
  try { return JSON.parse(response.text); }
  catch { throw new Error('测试响应不是有效 JSON。'); }
}

function privateSnapshotCheck(value) {
  assert.equal(value.ai.requests, 0);
  assert.equal(value.ai.enabled, false);
  assert.equal(value.ai.hexEnabled, false);
  const forbidden = /"(?:key|token|authorization|password|secret|apiKey|DEEPSEEK_API_KEY)"\s*:/i;
  const hex = value.hex.map(item => {
    assert.equal(['1', '2', '3', '1d', '2d', '3d', 'd', '12d', '13d', '23d'].includes(item.key), true);
    const { key, ...publicItem } = item;
    return publicItem;
  });
  assert.equal(forbidden.test(JSON.stringify({ ...value, hex })), false);
}

test('实际 HTTP 服务、回放与局域网只读权限集成', { timeout: 45000 }, async t => {
  const port = await emptyPort();
  // 只设置非秘密端口变量，子进程继承其余环境，不遍历或打印环境。
  const previousPort = process.env.AZUSA_PORT;
  let child;
  let spawnFailed = false;
  try {
    process.env.AZUSA_PORT = String(port);
    child = spawn(process.execPath, ['server.mjs', '--lan'], { cwd: root, stdio: 'ignore', windowsHide: true });
    child.on('error', () => { spawnFailed = true; });
  } finally {
    if (previousPort === undefined) delete process.env.AZUSA_PORT;
    else process.env.AZUSA_PORT = previousPort;
  }
  const control = value => request(port, '/api/control', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-panel-control': '1' }, body: JSON.stringify(value) });
  const state = async () => {
    const response = await request(port, '/api/state');
    assert.equal(response.status, 200);
    const value = parsed(response); privateSnapshotCheck(value); return value;
  };

  try {
    let health;
    for (let attempt = 0; attempt < 80; attempt++) {
      if (spawnFailed || child.exitCode !== null) throw new Error('独立测试服务启动失败。');
      try {
        const response = await request(port, '/api/health');
        if (response.status === 200) { health = parsed(response); break; }
      } catch { /* 等待本测试的子进程完成监听。 */ }
      await delay(50);
    }
    assert.equal(Boolean(health), true);
    assert.equal(health.app, 'azusa-validation');
    assert.equal(health.lanEnabled, true);
    assert.equal(typeof health.aiConfigured, 'boolean');

    await t.test('静态文件白名单不暴露源码、回放原文或配置', async () => {
      for (const path of ['/', '/panel', '/app.js', '/style.css']) {
        assert.equal((await request(port, path)).status, 200);
      }
      for (const [path, contentType] of [
        ['/assets/azusa-snack.jpg', 'image/jpeg'],
        ['/assets/azusa-brand.png', 'image/png'],
        ['/assets/azusa-computer.png', 'image/png'],
        ['/assets/azusa-cheer.gif', 'image/gif'],
        ['/assets/azusa-sing.gif', 'image/gif'],
        ['/assets/fonts/Manrope.ttf', 'font/ttf'],
      ]) {
        const asset = await request(port, path);
        assert.equal(asset.status, 200);
        assert.equal(asset.headers['content-type'], contentType);
      }
      for (const path of ['/.env.local', '/server.mjs', '/src/ai-service.mjs', '/data/replays/azusa-p3.json', '/.git/config', '/assets/private-screenshot.png', '/assets/README.md', '/assets/fonts/OFL.txt', '/assets/azusa-panel-brand.png']) {
        assert.equal((await request(port, path)).status, 404);
      }
      privateSnapshotCheck(await state());
    });

    await t.test('Host、Origin、控制请求头和 JSON 输入受到限制', async () => {
      assert.equal((await request(port, '/api/health', { headers: { Host: 'invalid.example' } })).status, 403);
      assert.equal((await request(port, '/api/state', { headers: { Origin: 'http://invalid.example' } })).status, 403);
      assert.equal((await request(port, '/api/state', { headers: { Origin: `http://127.0.0.1:${port}` } })).status, 200);
      assert.equal((await request(port, '/api/control', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'round' }) })).status, 403);
      assert.equal((await request(port, '/api/control', { method: 'POST', headers: { 'Content-Type': 'text/plain', 'x-panel-control': '1' },
        body: '{}' })).status, 400);
      assert.equal((await request(port, '/api/control', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-panel-control': '1' },
        body: '{bad-json' })).status, 400);
      const before = (await state()).roundId;
      const oversized = JSON.stringify({ action: 'round', padding: 'x'.repeat(70000) });
      assert.equal((await request(port, '/api/control', { method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-panel-control': '1' }, body: oversized })).status, 400);
      assert.equal((await state()).roundId, before);
    });

    await t.test('本机控制可选择模式、口径、新轮和锁定，AI 始终关闭', async () => {
      const response = await control({ action: 'round', mode: 'equipment', counting: 'anonymous', seconds: 15 });
      assert.equal(response.status, 200);
      const value = parsed(response); privateSnapshotCheck(value);
      assert.equal(value.mode, 'equipment');
      assert.equal(value.counting, 'anonymous');
      assert.match(value.countingLabel, /实验/);
      assert.equal((await control({ action: 'lock' })).status, 200);
      assert.equal((await state()).status, 'locked');
      assert.equal((await control({ action: 'round', mode: 'hex', counting: 'messages', seconds: 10 })).status, 200);
      assert.equal((await control({ action: 'ai', enabled: false, hexEnabled: false, model: 'deepseek-flash' })).status, 200);
      for (const field of ['enabled', 'hexEnabled']) {
        assert.equal((await control({ action: 'ai', [field]: 'false' })).status, 400);
        const flags = (await state()).ai;
        assert.equal(flags.enabled, false);
        assert.equal(flags.hexEnabled, false);
      }
    });

    await t.test('真实 P3 正常速度回放 10 秒，35 条建议与独立复核一致', async () => {
      assert.equal((await control({ action: 'replay-load', dataset: 'azusa-p3', position: 1480, speed: 1 })).status, 200);
      assert.equal((await control({ action: 'replay-play', mode: 'hex', counting: 'messages', seconds: 10 })).status, 200);
      await delay(10300);
      const value = await state();
      assert.equal(value.hex.reduce((sum, item) => sum + item.votes, 0), 35);
      assert.equal(value.hex.find(item => item.key === '1').votes, 12);
      assert.equal(value.hex.find(item => item.key === '2').votes, 22);
      assert.equal(value.hex.find(item => item.key === '3').votes, 1);
      const audit = parsed(await request(port, '/api/hex-audit'));
      assert.equal(audit.roundId, value.roundId);
      assert.ok(audit.samples.length > 0 && audit.samples.length <= 20);
      assert.equal(audit.samples.some(row => typeof row.text === 'string'), true);
      assert.equal(JSON.stringify(value).includes('samples'), false);
      assert.equal(value.status, 'locked');
      assert.equal(value.lockReason, 'timeout');
      assert.equal((await control({ action: 'replay-pause' })).status, 200);
      const paused = await state();
      assert.equal(paused.source.state, 'paused');
      assert.equal(paused.connection, 'connected');
      assert.equal(paused.status, 'locked');
      assert.equal(paused.hex.reduce((sum, item) => sum + item.votes, 0), 35);
      assert.equal(paused.hex.find(item => item.key === '2').votes, 22);
    });

    await t.test('非法回放来源参数与直播间编号不会改变当前暂停回放', async () => {
      const before = await state();
      assert.equal(before.sourceKind, 'replay');
      assert.equal(before.source.dataset, 'azusa-p3');
      assert.equal(before.source.state, 'paused');
      const unchanged = value => ({
        sourceKind: value.sourceKind, dataset: value.source.dataset, position: value.source.position,
        generation: value.source.generation, sourceState: value.source.state, speed: value.source.speed,
        roundId: value.roundId, connection: value.connection, status: value.status, hex: value.hex,
      });
      const invalid = [
        { action: 'replay-load', dataset: 'azusa-p3', position: 1480, speed: 3 },
        { action: 'replay-load', dataset: 'azusa-p3', position: -1, speed: 1 },
        { action: 'replay-load', dataset: '../azusa-p3', position: 1480, speed: 1 },
        { action: 'live', room: 0 },
        { action: 'live', room: 1.5 },
        { action: 'live', room: 'invalid' },
      ];
      for (const value of invalid) {
        assert.equal((await control(value)).status, 400);
        assert.deepEqual(unchanged(await state()), unchanged(before));
      }
    });

    await t.test('回放播放参数无效时不会先启动来源或改变锁定结果', async () => {
      const before = await state();
      assert.equal((await control({ action: 'replay-play', mode: 'invalid', seconds: 10 })).status, 400);
      const after = await state();
      assert.equal(after.source.state, before.source.state);
      assert.equal(after.roundId, before.roundId);
      assert.deepEqual(after.hex, before.hex);
    });

    await t.test('重复定位使用新代际与匿名新轮，不跨片段合并旧结果', async () => {
      const before = await state();
      assert.equal((await control({ action: 'replay-load', dataset: 'azusa-p3', position: 1480, speed: 1 })).status, 200);
      const loaded = await state();
      assert.ok(loaded.source.generation > before.source.generation);
      assert.equal((await control({ action: 'replay-play', mode: 'hex', counting: 'anonymous', seconds: 10 })).status, 200);
      await delay(1000);
      const value = await state();
      assert.equal(value.counting, 'anonymous');
      assert.equal(value.hex.find(item => item.key === '1').votes, 2);
      assert.equal(value.hex.find(item => item.key === '2').votes, 0);
      assert.equal((await control({ action: 'replay-pause' })).status, 200);
    });

    await t.test('SSE 首个事件可读取和取消，快照不包含认证信息', async () => {
      const controller = new AbortController();
      let reader;
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/events`, { signal: controller.signal });
        assert.equal(response.status, 200);
        assert.match(response.headers.get('content-type'), /text\/event-stream/);
        reader = response.body.getReader();
        const decoder = new TextDecoder();
        let content = '';
        while (!content.includes('\n\n')) {
          const part = await reader.read();
          assert.equal(part.done, false);
          content += decoder.decode(part.value, { stream: true });
        }
        const first = content.split('\n\n')[0];
        privateSnapshotCheck(JSON.parse(first.slice('data: '.length)));
      } finally {
        await reader?.cancel().catch(() => {});
        controller.abort();
      }
      assert.equal((await request(port, '/api/health')).status, 200);
    });

    await t.test('本机非回环 IPv4 路径只允许配对后的只读访问', async subtest => {
      if (!health.viewerUrls?.length) {
        subtest.skip('本机没有可用非回环 IPv4，局域网权限未实测。');
        return;
      }
      let viewer;
      try { viewer = new URL(health.viewerUrls[0]); }
      catch { throw new Error('本机配对链接格式无效。'); }
      const hostname = viewer.hostname;
      const token = viewer.searchParams.get('token');
      assert.equal(typeof token, 'string');
      for (const path of ['/panel', '/api/state', '/api/health', '/api/replays', '/api/hex-audit', '/api/equipment-audit']) {
        assert.equal((await request(port, path, { hostname })).status, 403);
      }
      assert.equal((await request(port, viewer.pathname + viewer.search, { hostname })).status, 200);
      const paired = await request(port, '/api/state?token=' + encodeURIComponent(token), { hostname });
      assert.equal(paired.status, 200); privateSnapshotCheck(parsed(paired));
      for (const path of ['/api/health', '/api/replays', '/api/hex-audit', '/api/equipment-audit']) {
        assert.equal((await request(port, path + '?token=' + encodeURIComponent(token), { hostname })).status, 403);
      }
      for (const badToken of ['0'.repeat(48), '中文'.repeat(24)]) {
        assert.equal((await request(port, '/api/state?token=' + encodeURIComponent(badToken), { hostname })).status, 403);
      }
      assert.equal((await request(port, '/api/control?token=' + encodeURIComponent(token), { hostname, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-panel-control': '1' },
        body: JSON.stringify({ action: 'round' }) })).status, 403);
      assert.equal((await request(port, '/api/health')).status, 200);
    });

    await t.test('停止来源后明确不可用，后台不继续接收或发起 AI 请求', async () => {
      assert.equal((await control({ action: 'stop' })).status, 200);
      const stopped = await state();
      assert.equal(stopped.sourceKind, 'none');
      assert.equal(stopped.connection, 'disconnected');
      assert.equal(stopped.source.state, 'stopped');
      assert.equal(stopped.ai.requests, 0);
    });

    privateSnapshotCheck(await state());
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit').catch(() => {});
      child.kill('SIGTERM');
      let timer;
      try { await Promise.race([exited, new Promise(resolveExit => { timer = setTimeout(resolveExit, 3000); })]); }
      finally { clearTimeout(timer); }
      if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
    }
    await unlink(resolve(root, '.runtime', `server-${port}.json`)).catch(() => {});
  }
});

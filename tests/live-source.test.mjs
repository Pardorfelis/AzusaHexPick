import test from 'node:test';
import assert from 'node:assert/strict';
import { brotliCompressSync, deflateSync } from 'node:zlib';
import { LiveSource, decodePackets, encodePacket, normalizeDanmaku, validateRoomId, validatedSocketURL, wbiQuery } from '../src/live-source.mjs';

function danmaku({ text = '2d', candidate = 'deadbeef', id = 'event-one', extra, cmd = 'DANMU_MSG' } = {}) {
  const metadata = [];
  metadata[7] = candidate;
  metadata[15] = { extra: extra ?? JSON.stringify({ id_str: id, user_hash: 'unverified-extra' }) };
  return { cmd, info: [metadata, text, [1234567, '不应输出的昵称']] };
}

test('解析拼接包、Brotli 及 zlib 压缩，并保留心跳回复', () => {
  const data = Buffer.concat([encodePacket(8, { code: 0 }), encodePacket(5, danmaku()), encodePacket(3, Buffer.alloc(4))]);
  const expected = [8, 5, 3];
  assert.deepEqual(decodePackets(data).map(packet => packet.operation), expected);
  assert.deepEqual(decodePackets(encodePacket(5, brotliCompressSync(data), 3)).map(packet => packet.operation), expected);
  assert.deepEqual(decodePackets(encodePacket(5, deflateSync(data), 2)).map(packet => packet.operation), expected);
});

test('拒绝截断包、无效长度、未知版本、坏 JSON 和过大的解压输出', () => {
  const valid = encodePacket(5, danmaku());
  const badLength = Buffer.from(valid);
  badLength.writeUInt32BE(0, 0);
  const badHeader = Buffer.from(valid);
  badHeader.writeUInt16BE(valid.length + 1, 4);
  for (const packet of [Buffer.alloc(0), valid.subarray(0, 15), valid.subarray(0, valid.length - 1), badLength, badHeader, encodePacket(5, Buffer.from('{')), encodePacket(5, [], 1), encodePacket(5, danmaku(), 9)]) {
    assert.throws(() => decodePackets(packet));
  }
  const oversized = encodePacket(5, deflateSync(Buffer.alloc(8 * 1024 * 1024)), 2);
  assert.throws(() => decodePackets(oversized));
  assert.throws(() => decodePackets(Buffer.alloc(8 * 1024 * 1024 + 1)));
});

test('归一化仅输出会话盐哈希，使用接收时间和代次来源', () => {
  const message = danmaku({ cmd: 'DANMU_MSG:4:0:2:2:2:0' });
  const first = normalizeDanmaku(message, { salt: 'one-session', at: 123, generation: 4 });
  const reconnect = normalizeDanmaku(message, { salt: 'one-session', at: 456, generation: 5 });
  const anotherSession = normalizeDanmaku(message, { salt: 'another-session', at: 123, generation: 4 });
  assert.equal(first.text, '2d');
  assert.equal(first.at, 123);
  assert.equal(first.source, 'live:4');
  assert.equal(first.idReliable, true);
  assert.equal(first.id, reconnect.id);
  assert.equal(first.anonymousId, reconnect.anonymousId);
  assert.notEqual(first.anonymousId, anotherSession.anonymousId);
  assert.notEqual(first.id, anotherSession.id);
  const serialized = JSON.stringify(first);
  for (const privateValue of ['deadbeef', 'event-one', '1234567', '不应输出的昵称', 'unverified-extra']) assert.equal(serialized.includes(privateValue), false);
});

test('缺失身份与消息标识不能伪装成可精确去重，坏额外字段不阻塞合法文本', () => {
  const source = danmaku({ candidate: 0, extra: '{' });
  const first = normalizeDanmaku(source, { salt: 'session', generation: 1 });
  const second = normalizeDanmaku(source, { salt: 'session', generation: 1 });
  assert.equal(first.anonymousId, null);
  assert.equal(first.idReliable, false);
  assert.notEqual(first.id, second.id);
  assert.equal(first.text, '2d');
  assert.equal(normalizeDanmaku({ cmd: 'SEND_GIFT' }), null);
  assert.equal(normalizeDanmaku({ cmd: 'DANMU_MSG_FAKE', info: source.info }), null);
  assert.equal(normalizeDanmaku({ cmd: 'DANMU_MSG', info: [] }, { salt: 'session' }), null);
  assert.throws(() => normalizeDanmaku(danmaku(), {}), /随机盐/);
});

test('房间号及服务器域名验证阻止注入和任意外连', () => {
  assert.equal(validateRoomId('21452505'), 21452505);
  for (const value of [0, -1, 1.5, Infinity, null, {}, '1e3', '510&id=1', '9007199254740992']) assert.throws(() => validateRoomId(value));
  assert.equal(validatedSocketURL({ host: 'zj-cn-live-comet.chat.bilibili.com', wss_port: 2245 }), 'wss://zj-cn-live-comet.chat.bilibili.com:2245/sub');
  for (const host of ['bilibili.com.evil.test', 'bilibili.com', 'localhost', '127.0.0.1', 'evil.test@chat.bilibili.com', 'https://chat.bilibili.com', 'chat.bilibili.com/sub']) {
    assert.throws(() => validatedSocketURL({ host, wss_port: 443 }));
  }
  assert.throws(() => validatedSocketURL({ host: 'chat.bilibili.com', wss_port: 0 }));
  assert.throws(() => validatedSocketURL({ host: 'chat.bilibili.com', wss_port: 65536 }));
  const query = wbiQuery(80397, { img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png', sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png' }, 1702204169);
  assert.match(query, /^id=80397&type=0&wts=1702204169&w_rid=[a-f0-9]{32}$/);
  assert.throws(() => wbiQuery(80397, { img_url: 'file:///tmp/key.png', sub_url: 'file:///tmp/key.png' }));
});

class FakeClock {
  constructor() { this.time = 0; this.next = 0; this.entries = new Map(); }
  setTimeout = (callback, delay) => this.add(callback, delay, false);
  setInterval = (callback, delay) => this.add(callback, delay, true);
  clearTimeout = id => this.entries.delete(id);
  clearInterval = id => this.entries.delete(id);
  add(callback, delay, interval) {
    const id = ++this.next;
    this.entries.set(id, { callback, at: this.time + delay, delay, interval });
    return id;
  }
  tick(milliseconds) {
    const target = this.time + milliseconds;
    while (true) {
      const next = [...this.entries.entries()].filter(([, entry]) => entry.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      const [id, entry] = next;
      this.time = entry.at;
      if (entry.interval) entry.at += entry.delay; else this.entries.delete(id);
      entry.callback();
    }
    this.time = target;
  }
}

class FakeSocket {
  static instances = [];
  constructor(url) { this.url = url; this.listeners = new Map(); this.sent = []; this.closeCalls = 0; FakeSocket.instances.push(this); }
  addEventListener(name, listener) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name).add(listener);
  }
  removeEventListener(name, listener) { this.listeners.get(name)?.delete(listener); }
  emit(name, event = {}) { for (const listener of [...this.listeners.get(name) || []]) listener(event); }
  send(bytes) { this.sent.push(bytes); }
  close() { this.closeCalls++; }
  authenticate(code = 0) { this.emit('open'); this.emit('message', { data: encodePacket(8, { code }) }); }
  chat(options) { this.emit('message', { data: encodePacket(5, danmaku(options)) }); }
}

function fixture({ offline = false, discoveryCode = 0, host = 'chat.bilibili.com', rejectFetch = false } = {}) {
  FakeSocket.instances = [];
  const clock = new FakeClock();
  const statuses = [];
  const messages = [];
  const calls = [];
  const fetch = async (url, options) => {
    calls.push({ url, options });
    if (rejectFetch) throw new Error('模拟瞬断');
    let body;
    if (url.includes('/room_init')) body = { code: 0, data: { room_id: 80397, live_status: offline ? 0 : 1 } };
    else if (url.includes('/nav')) body = { code: -101, data: { wbi_img: { img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png', sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png' } } };
    else if (url.includes('/getDanmuInfo')) body = { code: discoveryCode, data: { token: '不应进入回调的令牌', host_list: [{ host, wss_port: 2245 }] } };
    else if (url.includes('/spi_v2')) body = { code: 0, data: { b_3: '测试游客设备' } };
    else throw new Error('意外接口');
    return { ok: true, json: async () => body };
  };
  const source = new LiveSource({ onStatus: status => statuses.push(status), onMessage: message => messages.push(message) }, {
    fetch, WebSocket: FakeSocket, now: () => clock.time,
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    setInterval: clock.setInterval, clearInterval: clock.clearInterval,
  });
  return { source, statuses, messages, calls, clock };
}

const settle = async () => { for (let step = 0; step < 40; step++) await Promise.resolve(); };

test('下播状态明确且不创建连接、不假成功、不重试', async () => {
  const { source, statuses, calls, clock } = fixture({ offline: true });
  await source.connect(510);
  assert.equal(statuses.at(-1).state, 'offline');
  assert.equal(calls.length, 1);
  assert.equal(FakeSocket.instances.length, 0);
  assert.equal(clock.entries.size, 0);
  assert.equal(statuses.some(status => status.state === 'live'), false);
});

test('接口拒绝和恶意服务器停止接入，不自动尝试绕过', async () => {
  for (const options of [{ discoveryCode: -352 }, { host: 'chat.evil.test' }]) {
    const { source, statuses, clock } = fixture(options);
    await source.connect(510);
    assert.equal(statuses.at(-1).state, 'error');
    assert.equal(source.attempt, 0);
    assert.equal(FakeSocket.instances.length, 0);
    assert.equal(clock.entries.size, 0);
  }
});

test('旧代次的异步接口返回被忽略，停止能取消准备阶段请求', async () => {
  const { source, statuses } = fixture();
  const initialFetch = source.fetch;
  let resolveFirst;
  let oldSignal;
  let first = true;
  source.fetch = (url, options) => {
    if (!first) return initialFetch(url, options);
    first = false;
    oldSignal = options.signal;
    return new Promise(resolve => { resolveFirst = resolve; });
  };
  const pending = source.connect(510);
  await source.connect(21452505);
  assert.equal(oldSignal.aborted, true);
  resolveFirst({ ok: true, json: async () => ({ code: 0, data: { room_id: 80397, live_status: 1 } }) });
  await pending;
  assert.equal(FakeSocket.instances.length, 1);
  assert.equal(statuses.at(-1).roomId, 21452505);
  FakeSocket.instances[0].authenticate();
  assert.equal(statuses.at(-1).state, 'live');
  source.stop();
});

test('HTTP 拒绝立即停止，不以重试绕过接口限制', async () => {
  const { source, statuses, clock } = fixture();
  source.fetch = async () => ({ ok: false, status: 403 });
  await source.connect(510);
  assert.equal(statuses.at(-1).state, 'error');
  assert.equal(source.attempt, 0);
  assert.equal(FakeSocket.instances.length, 0);
  assert.equal(clock.entries.size, 0);
});

test('订阅鉴权拒绝立即停止，未鉴权的消息不参与计票', async () => {
  const { source, statuses, messages, clock } = fixture();
  await source.connect(510);
  const socket = FakeSocket.instances[0];
  socket.chat();
  assert.equal(messages.length, 0);
  socket.authenticate(-101);
  assert.equal(statuses.at(-1).state, 'error');
  assert.equal(source.attempt, 0);
  assert.equal(clock.entries.size, 0);
  socket.chat();
  assert.equal(messages.length, 0);
});

test('停止立即更新状态并清理监听和计时，不等待服务端关闭握手', async () => {
  const { source, statuses, messages, calls, clock } = fixture();
  await source.connect(510);
  const socket = FakeSocket.instances[0];
  socket.authenticate();
  socket.chat();
  assert.equal(messages.length, 1);
  assert.equal(messages[0].source, `live:${statuses.at(-1).generation}`);
  assert.equal(statuses.at(-1).reconnected, false);
  for (const call of calls) {
    assert.equal(call.options.credentials, 'omit');
    assert.equal(call.options.redirect, 'error');
    assert.equal(Object.keys(call.options.headers).some(key => key.toLowerCase() === 'cookie'), false);
  }
  const beforeHeartbeat = socket.sent.length;
  clock.tick(30000);
  assert.equal(socket.sent.length, beforeHeartbeat + 1);
  source.stop();
  assert.equal(statuses.at(-1).state, 'stopped');
  assert.equal(socket.closeCalls, 1);
  assert.equal(clock.entries.size, 0);
  for (const listeners of socket.listeners.values()) assert.equal(listeners.size, 0);
  clock.tick(60000);
  socket.chat();
  assert.equal(messages.length, 1);
  assert.equal(socket.sent.length, beforeHeartbeat + 1);
  assert.equal(JSON.stringify(statuses).includes('不应进入回调的令牌'), false);
});

test('重连弃用旧代次，保持匿名标识并明确通知新连接', async () => {
  const { source, statuses, messages, clock } = fixture();
  await source.connect(510);
  const old = FakeSocket.instances[0];
  old.authenticate();
  old.chat();
  const queuedMessage = [...old.listeners.get('message')][0];
  const queuedClose = [...old.listeners.get('close')][0];
  old.emit('error');
  const reconnectGeneration = statuses.at(-1).generation;
  assert.equal(statuses.at(-1).state, 'reconnecting');
  queuedClose();
  assert.equal(source.attempt, 1);
  clock.tick(1000);
  await settle();
  const current = FakeSocket.instances[1];
  current.authenticate();
  current.chat({ id: 'event-two' });
  queuedMessage({ data: encodePacket(5, danmaku({ id: 'stale-message' })) });
  assert.equal(messages.length, 2);
  assert.equal(messages[0].anonymousId, messages[1].anonymousId);
  assert.notEqual(messages[0].source, messages[1].source);
  assert.equal(messages[1].source, `live:${reconnectGeneration}`);
  assert.equal(statuses.at(-1).reconnected, true);
  source.stop();
});

test('自动重试最多三次，成功重连不重置上限，不产生重复监听', async () => {
  const { source, statuses, clock } = fixture();
  await source.connect(510);
  for (let attempt = 0; attempt < 4; attempt++) {
    const socket = FakeSocket.instances[attempt];
    socket.authenticate();
    socket.emit('error');
    socket.emit('close');
    if (attempt < 3) {
      assert.equal(statuses.at(-1).state, 'reconnecting');
      assert.equal(source.attempt, attempt + 1);
      clock.tick(1000 * 2 ** attempt);
      await settle();
    }
  }
  assert.equal(statuses.at(-1).state, 'error');
  assert.equal(source.attempt, 3);
  assert.equal(FakeSocket.instances.length, 4);
  assert.equal(clock.entries.size, 0);
  for (const socket of FakeSocket.instances) for (const listeners of socket.listeners.values()) assert.equal(listeners.size, 0);
});

test('网络准备失败有限重试，主动停止取消后续重试', async () => {
  const { source, statuses, calls, clock } = fixture({ rejectFetch: true });
  await source.connect(510);
  assert.equal(statuses.at(-1).state, 'reconnecting');
  assert.equal(calls.length, 1);
  source.stop();
  clock.tick(10000);
  await settle();
  assert.equal(calls.length, 1);
  assert.equal(statuses.at(-1).state, 'stopped');
  await assert.rejects(source.connect('510&uid=1'), /正整数/);
  assert.equal(calls.length, 1);
});

test('坏包及鉴权超时停止，心跳长时间无回复触发有限恢复', async () => {
  const bad = fixture();
  await bad.source.connect(510);
  FakeSocket.instances[0].authenticate();
  FakeSocket.instances[0].emit('message', { data: Buffer.alloc(3) });
  assert.equal(bad.statuses.at(-1).state, 'error');
  assert.equal(bad.clock.entries.size, 0);
  const timeout = fixture();
  await timeout.source.connect(510);
  timeout.clock.tick(15000);
  assert.equal(timeout.statuses.at(-1).state, 'error');
  assert.equal(timeout.source.attempt, 0);
  const heartbeat = fixture();
  await heartbeat.source.connect(510);
  FakeSocket.instances[0].authenticate();
  heartbeat.clock.tick(90000);
  assert.equal(heartbeat.statuses.at(-1).state, 'reconnecting');
  assert.equal(heartbeat.source.attempt, 1);
  heartbeat.source.stop();
});

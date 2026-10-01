import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { brotliDecompressSync, inflateSync } from 'node:zlib';

const MAX_PACKET_BYTES = 8 * 1024 * 1024;
const WBI_TABLE = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52];
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

class PermanentError extends Error {}

export function validateRoomId(value) {
  if (!['string', 'number'].includes(typeof value) || !/^\d+$/.test(String(value))) {
    throw new TypeError('直播间号必须是正整数。');
  }
  const roomId = Number(value);
  if (!Number.isSafeInteger(roomId) || roomId <= 0) throw new TypeError('直播间号必须是正整数。');
  return roomId;
}

export function validatedSocketURL(host) {
  if (!host || typeof host.host !== 'string' || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.bilibili\.com$/i.test(host.host)) {
    throw new PermanentError('弹幕服务器域名不在允许范围内。');
  }
  const port = Number(host.wss_port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new PermanentError('弹幕服务器端口无效。');
  return `wss://${host.host.toLowerCase()}:${port}/sub`;
}

export function wbiQuery(roomId, images, seconds = Math.floor(Date.now() / 1000)) {
  const key = value => {
    let url;
    try { url = new URL(value); } catch { throw new PermanentError('公开签名资料无效。'); }
    const name = url.pathname.split('/').at(-1)?.replace(/\.png$/, '');
    if (url.protocol !== 'https:' || !/^[a-f0-9]{32}$/i.test(name || '')) throw new PermanentError('公开签名资料无效。');
    return name;
  };
  if (!images || !Number.isSafeInteger(seconds) || seconds < 0) throw new PermanentError('公开签名资料无效。');
  const original = key(images.img_url) + key(images.sub_url);
  const mix = WBI_TABLE.map(index => original[index]).join('').slice(0, 32);
  const query = `id=${validateRoomId(roomId)}&type=0&wts=${seconds}`;
  return query + '&w_rid=' + createHash('md5').update(query + mix).digest('hex');
}

export function encodePacket(operation, body = Buffer.alloc(0), version = 1) {
  if (!Buffer.isBuffer(body)) body = Buffer.from(JSON.stringify(body));
  const header = Buffer.alloc(16);
  header.writeUInt32BE(16 + body.length, 0);
  header.writeUInt16BE(16, 4);
  header.writeUInt16BE(version, 6);
  header.writeUInt32BE(operation, 8);
  header.writeUInt32BE(1, 12);
  return Buffer.concat([header, body]);
}

// 限制包大小、解压后大小及嵌套层数，坏包不能继续参与计票。
export function decodePackets(data) {
  const packets = [];
  let remainingBytes = MAX_PACKET_BYTES;
  const decode = (buffer, depth = 0) => {
    if (depth > 8 || buffer.length > remainingBytes) throw new Error('弹幕数据超过解析限制。');
    if (buffer.length < 16) throw new Error('弹幕包头不完整。');
    remainingBytes -= buffer.length;
    for (let offset = 0; offset < buffer.length;) {
      if (buffer.length - offset < 16) throw new Error('弹幕包头不完整。');
      const length = buffer.readUInt32BE(offset);
      const headerLength = buffer.readUInt16BE(offset + 4);
      const version = buffer.readUInt16BE(offset + 6);
      const operation = buffer.readUInt32BE(offset + 8);
      if (length < 16 || headerLength < 16 || headerLength > length || length > buffer.length - offset) {
        throw new Error('弹幕包长度无效。');
      }
      const body = buffer.subarray(offset + headerLength, offset + length);
      if (operation === 5 && (version === 2 || version === 3)) {
        const decompress = version === 3 ? brotliDecompressSync : inflateSync;
        decode(decompress(body, { maxOutputLength: Math.max(1, remainingBytes) }), depth + 1);
      } else if (operation === 5 || operation === 8) {
        if (version !== 0 && version !== 1) throw new Error('弹幕协议版本不支持。');
        let message;
        try { message = JSON.parse(body.toString('utf8')); } catch { throw new Error('弹幕内容不是有效 JSON。'); }
        if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('弹幕内容结构无效。');
        packets.push({ operation, message });
      } else if (operation === 3) {
        packets.push({ operation });
      }
      offset += length;
    }
  };
  decode(Buffer.from(data));
  return packets;
}

function opaqueValue(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  if (typeof value === 'number' && !Number.isSafeInteger(value)) return null;
  const text = String(value).trim();
  return text && text !== '0' && text.length <= 128 ? text : null;
}

export function normalizeDanmaku(message, { salt, at = Date.now(), generation = 0, fallbackId = randomUUID() } = {}) {
  if (!/^DANMU_MSG(?::|$)/.test(message?.cmd || '')) return null;
  const info = message.info;
  if (!Array.isArray(info) || typeof info[1] !== 'string' || info[1].length > 4096) return null;
  if (!salt || (!Buffer.isBuffer(salt) && typeof salt !== 'string')) throw new TypeError('必须提供会话随机盐。');
  const digest = (kind, value) => createHash('sha256').update(salt).update(':' + kind + ':' + value).digest('hex').slice(0, 24);
  let extra = info[0]?.[15]?.extra;
  if (typeof extra === 'string') {
    try { extra = extra.length <= 65536 ? JSON.parse(extra) : null; } catch { extra = null; }
  }
  const messageId = opaqueValue(extra?.id_str ?? extra?.id);
  const candidate = opaqueValue(info[0]?.[7]);
  return {
    id: messageId ? 'msg:' + digest('message', messageId) : 'local:' + fallbackId,
    idReliable: Boolean(messageId), text: info[1],
    anonymousId: candidate ? digest('anonymous', candidate.toLowerCase()) : null,
    at, source: `live:${generation}`,
  };
}

/**
 * 游客实时源，不读取 Cookie，不持久化昵称、UID、令牌或原始匿名标识。
 * 第二个参数仅用于注入测试依赖。重连次数按一次 connect 会话累计。
 */
export class LiveSource {
  constructor({ onMessage = () => {}, onStatus = () => {} } = {}, dependencies = {}) {
    this.onMessage = onMessage;
    this.onStatus = onStatus;
    this.fetch = dependencies.fetch || globalThis.fetch;
    this.WebSocket = dependencies.WebSocket || globalThis.WebSocket;
    this.timeout = dependencies.setTimeout || globalThis.setTimeout;
    this.clearTimeout = dependencies.clearTimeout || globalThis.clearTimeout;
    this.interval = dependencies.setInterval || globalThis.setInterval;
    this.clearInterval = dependencies.clearInterval || globalThis.clearInterval;
    this.now = dependencies.now || Date.now;
    this.generation = 0;
    this.attempt = 0;
    this.roomId = null;
    this.socket = null;
    this.timers = new Set();
    this.listeners = [];
    this.salt = randomBytes(32);
    this.hadLive = false;
    this.device = null;
  }

  async connect(roomId) {
    const requested = validateRoomId(roomId);
    this.generation++;
    this.dispose();
    this.roomId = requested;
    this.attempt = 0;
    this.hadLive = false;
    this.device = null;
    this.salt = randomBytes(32);
    this.status('connecting', '正在连接直播间。');
    await this.open(this.generation);
  }

  stop() {
    this.generation++;
    this.dispose();
    this.status('stopped', '已停止接收弹幕。');
  }

  status(state, message, extra = {}) {
    this.onStatus({ state, message, roomId: this.roomId, attempt: this.attempt, generation: this.generation, ...extra });
  }

  later(callback, delay) {
    const timer = this.timeout(() => { this.timers.delete(timer); callback(); }, delay);
    timer?.unref?.();
    this.timers.add(timer);
    return timer;
  }

  dispose() {
    this.abort?.abort();
    this.abort = null;
    for (const timer of this.timers) this.clearTimeout(timer);
    this.timers.clear();
    if (this.heartbeat) this.clearInterval(this.heartbeat);
    this.heartbeat = null;
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      for (const [name, listener] of this.listeners) socket.removeEventListener(name, listener);
      // 内置 WebSocket 不能强制终止底层套接字，业务状态先停止，不等待关闭握手。
      try { socket.close(1000, 'source stopped'); } catch {}
    }
    this.listeners = [];
  }

  halt(state, message) {
    this.generation++;
    this.dispose();
    this.status(state, message);
  }

  retry(generation) {
    if (generation !== this.generation) return;
    this.generation++;
    this.dispose();
    if (this.attempt >= 3) {
      this.status('error', '连接中断，已达到 3 次重试上限，请手动重新连接。');
      return;
    }
    this.attempt++;
    const next = this.generation;
    this.status('reconnecting', '连接中断，正在尝试恢复；中断期间弹幕无法补回。');
    this.later(() => this.open(next), 1000 * 2 ** (this.attempt - 1));
  }

  async json(url, generation) {
    const response = await this.fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Referer: `https://live.bilibili.com/${this.roomId}`, Origin: 'https://live.bilibili.com' },
      credentials: 'omit', redirect: 'error',
      signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(10000)]),
    });
    if (generation !== this.generation) return null;
    if (!response.ok) throw new PermanentError('直播接口拒绝请求，已停止接入。');
    try { return await response.json(); } catch { throw new PermanentError('直播接口返回格式无效，已停止接入。'); }
  }

  async open(generation) {
    if (generation !== this.generation) return;
    this.abort = new AbortController();
    try {
      const room = await this.json('https://api.live.bilibili.com/room/v1/Room/room_init?id=' + this.roomId, generation);
      if (generation !== this.generation) return;
      if (room?.code !== 0) throw new PermanentError('直播间信息请求被拒绝。');
      if (room.data?.live_status !== 1) { this.halt('offline', '该直播间当前未开播。'); return; }
      const actualRoom = validateRoomId(room.data?.room_id);
      const nav = await this.json('https://api.bilibili.com/x/web-interface/nav', generation);
      if (generation !== this.generation) return;
      if (nav?.code !== 0 && nav?.code !== -101) throw new PermanentError('公开游客签名信息请求被拒绝。');
      const query = wbiQuery(actualRoom, nav.data?.wbi_img, Math.floor(this.now() / 1000));
      const discovery = await this.json('https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo?' + query, generation);
      if (generation !== this.generation) return;
      if (discovery?.code !== 0 || typeof discovery.data?.token !== 'string' || !discovery.data.token) {
        throw new PermanentError('弹幕订阅信息请求被拒绝，已停止接入。');
      }
      const transport = validatedSocketURL(discovery.data.host_list?.[0]);
      if (!this.device) {
        const finger = await this.json('https://api.bilibili.com/x/frontend/finger/spi_v2', generation);
        if (generation !== this.generation) return;
        if (finger?.code !== 0 || typeof finger.data?.b_3 !== 'string' || !finger.data.b_3) throw new PermanentError('游客设备信息请求被拒绝。');
        this.device = finger.data.b_3;
      }
      this.listen(transport, { uid: 0, roomid: actualRoom, protover: 3, platform: 'web', type: 2, buvid: this.device, key: discovery.data.token }, generation);
    } catch (error) {
      if (generation !== this.generation) return;
      if (error instanceof PermanentError || error instanceof TypeError && error.message === '直播间号必须是正整数。') {
        this.halt('error', error.message);
      } else this.retry(generation);
    }
  }

  listen(transport, auth, generation) {
    const socket = new this.WebSocket(transport);
    this.socket = socket;
    socket.binaryType = 'arraybuffer';
    let authenticated = false;
    let lastReply = this.now();
    const alive = () => generation === this.generation && socket === this.socket;
    const add = (name, listener) => {
      socket.addEventListener(name, listener);
      this.listeners.push([name, listener]);
    };
    add('open', () => {
      if (!alive()) return;
      try { socket.send(encodePacket(7, auth)); } catch { this.retry(generation); }
    });
    add('message', event => {
      if (!alive()) return;
      let packets;
      try { packets = decodePackets(event.data); }
      catch { this.halt('error', '收到无法解析的弹幕包，已停止接入。'); return; }
      for (const packet of packets) {
        if (!alive()) return;
        if (packet.operation === 8) {
          if (packet.message.code !== 0) { this.halt('error', '弹幕订阅鉴权被拒绝，已停止接入。'); return; }
          if (authenticated) continue;
          authenticated = true;
          lastReply = this.now();
          try { socket.send(encodePacket(2)); } catch { this.retry(generation); return; }
          this.heartbeat = this.interval(() => {
            if (!alive()) return;
            if (this.now() - lastReply > 65000) { this.retry(generation); return; }
            try { socket.send(encodePacket(2)); } catch { this.retry(generation); }
          }, 30000);
          this.heartbeat?.unref?.();
          const reconnected = this.hadLive;
          this.hadLive = true;
          this.status('live', '已接入直播间；按匿名标识统计，不能视为精确人数。', { reconnected });
        } else if (packet.operation === 3) lastReply = this.now();
        else if (packet.operation === 5 && authenticated) {
          const message = normalizeDanmaku(packet.message, { salt: this.salt, at: this.now(), generation });
          if (message) this.onMessage(message);
        }
      }
    });
    add('error', () => alive() && this.retry(generation));
    add('close', () => alive() && this.retry(generation));
    this.later(() => {
      if (alive() && !authenticated) this.halt('error', '弹幕订阅鉴权超时，已停止接入。');
    }, 15000);
  }
}

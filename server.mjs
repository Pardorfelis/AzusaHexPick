import http from 'node:http';
import { readFile, mkdir, writeFile, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { PanelEngine } from './src/engine.mjs';
import { LiveSource } from './src/live-source.mjs';
import { ReplaySource } from './src/replay-source.mjs';
import { AiService, loadLocalKey } from './src/ai-service.mjs';
import { allowedEquipment } from './src/equipment.mjs';
import { SongLists } from './src/song-lists.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const appVersion = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8')).version;
const port = Number(process.env.AZUSA_PORT || 5178);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('端口无效。');
const origin = 'http://127.0.0.1:' + port;
const lanEnabled = process.argv.includes('--lan');
const viewerToken = randomBytes(24).toString('hex');
const lanAddresses = Object.values(networkInterfaces()).flat()
  .filter(address => address && address.family === 'IPv4' && !address.internal)
  .map(address => address.address);
const allowedHosts = ['127.0.0.1:' + port, 'localhost:' + port, ...lanAddresses.map(address => address + ':' + port)];
const isLocal = request => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress);
function validViewerToken(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{48}$/.test(value)) return false;
  return timingSafeEqual(Buffer.from(value), Buffer.from(viewerToken));
}
const songLists = new SongLists({ path: process.env.AZUSA_SONG_BLACKLIST_FILE || resolve(root, 'data/song-blacklist.json') });
const engine = new PanelEngine({ songLists });
const listeners = new Set();
let sourceKind = 'none';
let liveStatus = {state: 'stopped'};
let sourceGeneration = '';
let helperSeenAt = 0;
let lastError = '';
let shuttingDown = false;
let revision = 0;
let roundOptions = {mode: 'hex', counting: 'messages', seconds: 20};

function changed() { revision += 1; broadcast(); }
const ai = new AiService({engine, key: await loadLocalKey(resolve(root, '.env.local')), onChange: changed});

function accept(message) {
  const result = engine.ingest(message);
  if (result?.accepted || result?.pending) changed();
}

const live = new LiveSource({
  onMessage: message => {
    if (sourceKind !== 'live') return;
    accept(message);
  },
  onStatus: status => {
    if (sourceKind !== 'live') return;
    liveStatus = status;
    sourceGeneration = 'live:' + status.generation;
    const state = status.state === 'live' ? 'connected'
      : ['connecting', 'reconnecting'].includes(status.state) ? 'connecting'
      : status.state === 'error' ? 'error' : 'disconnected';
    engine.setConnection(state, sourceGeneration);
    changed();
  },
});

const replay = new ReplaySource({
  directory: resolve(root, 'data/replays'),
  onMessage: message => {
    if (sourceKind !== 'replay') return;
    accept(message);
  },
  onStatus: status => {
    if (sourceKind !== 'replay') return;
    sourceGeneration = 'replay:' + status.generation;
    const available = Boolean(status.dataset) && ['playing', 'paused', 'ended'].includes(status.state);
    engine.setConnection(available ? 'connected' : 'disconnected', sourceGeneration);
    if (available && status.state !== 'playing') engine.lockRound('replay-paused');
    changed();
  },
});

function snapshot() {
  const value = engine.snapshot();
  return {
    ...value, revision, sourceKind,
    source: sourceKind === 'live' ? liveStatus : replay.snapshot(),
    ai: ai.snapshot(), helperConnected: Date.now() - helperSeenAt < 10000,
    supportedEquipment: allowedEquipment().length,
    error: lastError || songLists.warning,
  };
}

function broadcast() {
  if (shuttingDown) return;
  const data = 'data: ' + JSON.stringify(snapshot()) + '\n\n';
  for (const response of listeners) {
    if (response.writableLength > 256000) { response.destroy(); listeners.delete(response); }
    else response.write(data);
  }
}

function json(response, status, value) {
  response.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'});
  response.end(JSON.stringify(value));
}

async function body(request) {
  if (!request.headers['content-type']?.startsWith('application/json')) throw new Error('需要 JSON 请求。');
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 65536) throw new Error('请求过大。');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function roundSettings(value) {
  const options = {...roundOptions};
  if (value.mode !== undefined) {
    if (!['hex', 'equipment', 'songs'].includes(value.mode)) throw new Error('无效的模式。');
    options.mode = value.mode;
  }
  if (value.counting !== undefined) {
    if (!['messages', 'anonymous'].includes(value.counting)) throw new Error('无效的计票口径。');
    options.counting = value.counting;
  }
  if (value.seconds !== undefined) {
    if (![10, 15, 20, 30, 60, 120, 180, 300].includes(Number(value.seconds))) throw new Error('请选择支持的收集时长。');
    options.seconds = Number(value.seconds);
  }
  if (options.mode === 'songs') options.counting = 'messages';
  return options;
}

async function control(value) {
  lastError = '';
  switch (value.action) {
    case 'round':
      roundOptions = roundSettings(value);
      engine.startRound(roundOptions);
      break;
    case 'lock':
      engine.lockRound();
      break;
    case 'live': {
      const room = Number(value.room);
      if (!Number.isInteger(room) || room < 1 || room > 1e10) throw new Error('直播间编号无效。');
      replay.stop();
      live.stop();
      sourceKind = 'live';
      engine.setConnection('connecting', 'live:new');
      engine.startRound(roundOptions);
      engine.lockRound();
      await live.connect(room);
      break;
    }
    case 'replay-load': {
      const speed = Number(value.speed ?? 1);
      const position = Number(value.position ?? 0);
      if (![0.5, 1, 2, 4].includes(speed)) throw new Error('回放速度无效。');
      if (!Number.isFinite(position) || position < 0) throw new Error('回放位置无效。');
      if (typeof value.dataset !== 'string' || !/^[a-z0-9-]+$/.test(value.dataset)) throw new Error('无效的回放编号。');
      live.stop();
      sourceKind = 'replay';
      engine.setConnection('disconnected', 'replay:new');
      engine.startRound(roundOptions);
      engine.lockRound();
      await replay.load(value.dataset, position, speed);
      break;
    }
    case 'replay-play':
      if (sourceKind !== 'replay') throw new Error('请先选择回放。');
      roundOptions = roundSettings(value);
      replay.play();
      engine.startRound(roundOptions);
      break;
    case 'replay-pause':
      replay.pause();
      engine.lockRound();
      break;
    case 'stop':
      live.stop();
      replay.stop();
      engine.setConnection('disconnected', sourceGeneration);
      sourceKind = 'none';
      break;
    case 'ai':
      for (const field of ['enabled', 'hexEnabled'])
        if (value[field] !== undefined && typeof value[field] !== 'boolean') throw new Error('AI 开关必须是布尔值。');
      ai.configure({enabled: value.enabled ?? ai.enabled, hexEnabled: value.hexEnabled ?? ai.hexEnabled, model: value.model});
      break;
    case 'helper-heartbeat':
      helperSeenAt = value.active === false ? 0 : Date.now();
      break;
    case 'song-gray-add':
      engine.addSongGray(value.key, value.roundId);
      break;
    case 'song-gray-remove':
      if (value.sessionId !== songLists.sessionId) throw new Error('歌回场次已变化，请刷新名单后重试。');
      if (typeof value.key !== 'string' || value.key.length > 160) throw new Error('歌曲无效。');
      songLists.removeGray(value.key);
      break;
    case 'song-session-reset':
      engine.resetSongSession();
      break;
    case 'song-black-add':
      songLists.addBlack(value.title, value.term);
      break;
    case 'song-black-remove':
      if (typeof value.key !== 'string' || value.key.length > 160) throw new Error('歌曲无效。');
      songLists.removeBlack(value.key);
      break;
    case 'shutdown':
      setTimeout(shutdown, 100);
      break;
    default: throw new Error('未知操作。');
  }
  changed();
  return snapshot();
}

const publicFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/panel', ['index.html', 'text/html; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/assets/azusa-snack.jpg', ['assets/azusa-snack.jpg', 'image/jpeg']],
  ['/assets/azusa-brand.png', ['assets/azusa-brand.png', 'image/png']],
  ['/assets/azusa-computer.png', ['assets/azusa-computer.png', 'image/png']],
  ['/assets/azusa-cheer.gif', ['assets/azusa-cheer.gif', 'image/gif']],
  ['/assets/azusa-sing.gif', ['assets/azusa-sing.gif', 'image/gif']],
  ['/assets/fonts/Manrope.ttf', ['assets/fonts/Manrope.ttf', 'font/ttf']],
]);

const server = http.createServer(async (request, response) => {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'");
  if (!allowedHosts.includes(request.headers.host)) return json(response, 403, {error: '仅允许本机访问。'});
  if (request.headers.origin && request.headers.origin !== 'http://' + request.headers.host)
    return json(response, 403, {error: '跨站请求已拒绝。'});
  const url = new URL(request.url, origin);
  const local = isLocal(request);
  if (!local) {
    const staticAsset = publicFiles.has(url.pathname) && !['/', '/panel'].includes(url.pathname);
    const readonly = ['/panel', '/api/state', '/api/events'].includes(url.pathname);
    if (request.method !== 'GET' || !lanEnabled || (!staticAsset && (!readonly || !validViewerToken(url.searchParams.get('token')))))
      return json(response, 403, {error: '手机只读页需要本机提供的配对链接。'});
  }
  try {
    if (request.method === 'GET' && url.pathname === '/api/health')
      return json(response, 200, {
        app: 'azusa-validation', version: appVersion, aiConfigured: Boolean(ai.key),
        lanEnabled,
        viewerUrls: lanEnabled ? lanAddresses.map(address => 'http://' + address + ':' + port + '/panel?token=' + viewerToken) : [],
      });
    if (request.method === 'GET' && url.pathname === '/api/state') return json(response, 200, snapshot());
    if (request.method === 'GET' && url.pathname === '/api/hex-audit') return json(response, 200, engine.hexAudit());
    if (request.method === 'GET' && url.pathname === '/api/equipment-audit') return json(response, 200, engine.equipmentAudit());
    if (request.method === 'GET' && url.pathname === '/api/song-audit') return json(response, 200, engine.songAudit());
    if (request.method === 'GET' && url.pathname === '/api/song-lists') return json(response, 200, songLists.snapshot());
    if (request.method === 'GET' && url.pathname === '/api/replays') {
      const datasets = await replay.list();
      const inspection = JSON.parse(await readFile(resolve(root, 'validation/replay-inspection.json'), 'utf8').catch(() => '{"datasets":[]}'));
      for (const dataset of datasets) {
        const item = inspection.datasets.find(item => item.id === dataset.id);
        dataset.windows = [
          ...(dataset.windows || []),
          ...(item?.voteDense10SecondBins || []).slice(0, 3).map(item => ({mode: 'hex', at: item.startAtSeconds, label: '数字建议密集片段'})),
          ...(item?.equipmentDense10SecondBins || []).slice(0, 3).map(item => ({mode: 'equipment', at: item.startAtSeconds, label: '装备词密集片段'})),
        ];
      }
      return json(response, 200, datasets);
    }
    if (request.method === 'GET' && url.pathname === '/api/events') {
      response.writeHead(200, {'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'Connection': 'keep-alive'});
      listeners.add(response);
      response.write('data: ' + JSON.stringify(snapshot()) + '\n\n');
      response.on('close', () => listeners.delete(response));
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/control') {
      if (!local) return json(response, 403, {error: '手机页只读。'});
      if (request.headers['x-panel-control'] !== '1') return json(response, 403, {error: '控制请求无效。'});
      return json(response, 200, await control(await body(request)));
    }
    if (request.method === 'GET' && publicFiles.has(url.pathname)) {
      const [name, type] = publicFiles.get(url.pathname);
      const content = await readFile(resolve(root, 'public', name));
      response.writeHead(200, {'Content-Type': type, 'Cache-Control': 'no-store'});
      response.end(content);
      return;
    }
    json(response, 404, {error: '页面不存在。'});
  } catch (error) {
    const safeMessages = [
      '需要 JSON 请求。', '请求过大。', '无效的模式。', '无效的计票口径。',
      '请选择支持的收集时长。', '回放速度无效。', '回放位置无效。', '直播间编号无效。', '请先选择回放。', '未知操作。',
      '无效的回放编号。', '回放格式不正确。', '不支持的模型。',
      '未配置本机 DeepSeek 密钥。', '上次请求费用未知，请重启后再启用。',
      '请求处理中，请稍后切换。',
      '点歌轮次已变化，请从当前列表重新选择。', '歌曲已不在当前列表，请刷新后重试。',
      '歌回场次已变化，请刷新名单后重试。',
      '歌曲无效。', '本场灰名单已达上限。', '歌曲黑名单已达上限。', '请输入有效歌名。', '拉黑期限无效。',
      '歌曲黑名单未能保存，请检查本机文件写入权限。',
    ];
    lastError = safeMessages.includes(error.message) ? error.message
      : error.code === 'ENOENT' ? '回放文件尚未导入，请检查数据目录。'
      : '操作未完成，请检查来源、配置或输入。';
    changed();
    json(response, 400, {error: lastError});
  }
});

const updateTimer = setInterval(broadcast, 250);
const aiTimer = setInterval(() => ai.tick().catch(() => {}), 350);
updateTimer.unref();
aiTimer.unref();

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(updateTimer);
  clearInterval(aiTimer);
  ai.stop();
  live.stop();
  replay.stop();
  for (const response of listeners) response.end();
  await unlink(resolve(root, '.runtime/server-' + port + '.json')).catch(() => {});
  server.close();
  setTimeout(() => process.exit(0), 500).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
server.listen(port, lanEnabled ? '0.0.0.0' : '127.0.0.1', async () => {
  await mkdir(resolve(root, '.runtime'), {recursive: true});
  await writeFile(resolve(root, '.runtime/server-' + port + '.json'), JSON.stringify({port, pid: process.pid}), 'utf8');
  console.log('梓有妙选已启动：' + origin + '。AI 默认关闭。');
});
server.on('error', () => {
  console.error('启动失败，请检查端口是否被占用。');
  process.exit(1);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// 这是前端动作回归，不代替真实浏览器、布局或焦点验证。
const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const executable = source.replace(/\ninitialize\(\)\.catch[\s\S]*$/, '');

function snapshot(overrides = {}) {
  return {
    revision: 1, now: 1000, roundId: 1, mode: 'hex', counting: 'messages',
    countingLabel: '有效弹幕条数', seconds: 20, status: 'locked', connection: 'disconnected',
    remainingMs: 0, latestUpdateAt: null, validMessages: 0, sourceKind: 'none', source: {},
    hex: ['1', '2', '3', '1d', '2d', '3d'].map(key => ({ key, votes: 0, messageVotes: 0, anonymousVotes: 0 })),
    equipment: { top3: [], against: [] }, pendingCount: 0,
    supportedEquipment: 12,
    ai: { enabled: false, configured: false, model: 'deepseek-v4-pro', busy: false, requests: 0, estimatedPeakCostCny: 0 },
    ...overrides,
  };
}

class FakeElement {
  constructor(tag, register) {
    this.tagName = String(tag).toUpperCase();
    this.register = register;
    this._text = '';
    this._value = '';
    this._id = '';
    this.className = '';
    this.children = [];
    this.dataset = {};
    this.handlers = new Map();
    this.attributes = new Map();
    this.disabled = false;
    this.checked = false;
    this.hidden = false;
    this.classList = {
      contains: name => this.className.split(/\s+/).includes(name),
      add: name => this.classList.toggle(name, true),
      toggle: (name, force) => {
        const classes = new Set(this.className.split(/\s+/).filter(Boolean));
        const enabled = force ?? !classes.has(name);
        if (enabled) classes.add(name); else classes.delete(name);
        this.className = [...classes].join(' ');
        return enabled;
      },
    };
  }
  set id(value) { this._id = value; if (value) this.register(value, this); }
  get id() { return this._id; }
  set value(value) { this._value = String(value); }
  get value() { return this._value; }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(child => typeof child === 'string' ? child : child.textContent).join(''); }
  set innerHTML(_) { throw new Error('测试禁止使用 innerHTML 呈现动态内容。'); }
  set outerHTML(_) { throw new Error('测试禁止使用 outerHTML 呈现动态内容。'); }
  insertAdjacentHTML() { throw new Error('测试禁止插入动态 HTML。'); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  addEventListener(name, handler) {
    const handlers = this.handlers.get(name) || [];
    handlers.push(handler);
    this.handlers.set(name, handlers);
  }
  append(...children) {
    this.children.push(...children);
    if (this.tagName === 'SELECT' && !this._value && this.children.length) this._value = this.children[0].value;
  }
  replaceChildren(...children) {
    this._text = '';
    this.children = children;
    if (this.tagName === 'SELECT') this._value = children[0]?.value || '';
  }
  async fire(name) {
    if (name === 'click') assert.equal(this.disabled, false, '操作按钮需要可以点击');
    await Promise.all((this.handlers.get(name) || []).map(handler => handler({ target: this, currentTarget: this, type: name })));
  }
}

function documentFixture() {
  const nodes = new Map();
  const all = [];
  const register = (id, node) => nodes.set(id, node);
  const make = tag => { const node = new FakeElement(tag, register); all.push(node); return node; };
  for (const match of html.matchAll(/<([a-z][a-z0-9-]*)\b([^>]*)>/gi)) {
    const node = make(match[1]);
    const attributes = match[2];
    const id = /\bid="([^"]+)"/.exec(attributes);
    const className = /\bclass="([^"]*)"/.exec(attributes);
    if (id) node.id = id[1];
    if (className) node.className = className[1];
  }
  const defaults = {
    'dataset-select': '', 'replay-position': '00:24:40', 'replay-speed': '1', 'room-input': '510',
    'mode-select': 'hex', 'counting-select': 'messages', 'round-seconds': '20', 'ai-model': 'deepseek-v4-pro',
  };
  for (const [id, value] of Object.entries(defaults)) nodes.get(id).value = value;
  const body = all.find(node => node.tagName === 'BODY');
  return {
    nodes, body, activeElement: null,
    getElementById: id => nodes.get(id) || null,
    createElement: make,
    querySelector: selector => selector.startsWith('.') ? all.find(node => node.classList.contains(selector.slice(1))) : null,
    querySelectorAll: () => all.filter(node => ['BUTTON', 'INPUT', 'SELECT'].includes(node.tagName)),
    write() { throw new Error('测试禁止写入动态 HTML。'); },
  };
}

async function harness({ pathname = '/', token = '', state = snapshot(), onControl, windows, audit } = {}) {
  const document = documentFixture();
  const fetches = [];
  const events = [];
  const pageHandlers = new Map();
  const clockTimers = new Set();
  let active = structuredClone(state);
  let clock = 0;
  let timer = 0;
  const dataset = {
    id: 'azusa-p3', label: 'P3 阿梓回放', duration: 7213, count: 7328,
    windows: windows ?? [{ mode: 'equipment', at: 1580, label: '装备词密集片段' }],
  };
  class FakeEventSource {
    constructor(url) { this.url = url; this.closed = false; events.push(this); }
    close() { this.closed = true; }
    emit(value) { this.onmessage?.({ data: JSON.stringify(value) }); }
    disconnect() { this.onerror?.({}); }
  }
  const instance = {
    document, fetches, events,
    get: id => {
      const node = document.getElementById(id);
      assert.ok(node, '页面标识应存在：' + id);
      return node;
    },
    setState: value => { active = structuredClone(value); },
    emit: value => {
      const activeEvent = [...events].reverse().find(event => !event.closed);
      assert.ok(activeEvent, '应有一个活动消息流');
      activeEvent.emit(value);
    },
    advance: milliseconds => { clock += milliseconds; },
    clockTimers,
    pageHandlers,
    pageEvent: (name, details = {}) => {
      const handlers = pageHandlers.get(name) || [];
      for (const { handler } of handlers) handler({ type: name, ...details });
      pageHandlers.set(name, handlers.filter(record => !record.once));
    },
  };
  const context = vm.createContext({
    URL, URLSearchParams, AbortController, document,
    location: { origin: 'http://127.0.0.1:5178', pathname, search: token ? '?token=' + encodeURIComponent(token) : '' },
    performance: { now: () => clock },
    setTimeout: () => ++timer, clearTimeout() {},
    setInterval: () => { const id = ++timer; clockTimers.add(id); return id; },
    clearInterval: id => { clockTimers.delete(id); },
    navigator: { clipboard: { writeText: async () => {} } },
    window: { addEventListener: (name, handler, options = {}) => {
      const records = pageHandlers.get(name) || [];
      records.push({ handler, once: Boolean(options.once) });
      pageHandlers.set(name, records);
    } },
    EventSource: FakeEventSource,
    fetch: async (url, options = {}) => {
      const method = options.method || 'GET';
      const body = options.body ? JSON.parse(options.body) : null;
      fetches.push({ url, method, body, headers: options.headers || {} });
      const path = new URL(url).pathname;
      let value;
      if (method === 'GET' && path === '/api/state') value = active;
      else if (method === 'GET' && path === '/api/replays') value = [dataset];
      else if (method === 'GET' && path === '/api/health') value = { lanEnabled: false, viewerUrls: [] };
      else if (method === 'GET' && ['/api/hex-audit', '/api/equipment-audit'].includes(path)) value = audit;
      else if (method === 'POST' && path === '/api/control') {
        assert.ok(onControl, '测试没有为该控制动作设置响应');
        value = await onControl(body, instance);
        active = structuredClone(value);
      } else throw new Error('测试拒绝未预期的请求：' + method + ' ' + path);
      return { ok: true, json: async () => structuredClone(value) };
    },
  });
  vm.runInContext(executable, context, { filename: 'public/app.js' });
  instance.evaluate = expression => vm.runInContext(expression, context);
  instance.dispose = () => instance.pageEvent('pagehide');
  await instance.evaluate('initialize()');
  return instance;
}

test('收到、累计计入与未决分别展示，不用匿名票数替代消息总量', async () => {
  const app = await harness({ state: snapshot({ connection: 'connected', receivedMessages: 94, validMessages: 64,
    pendingCount: 3, pendingTotal: 4, counting: 'anonymous', hex: [{ key: '2', votes: 30 }],
    hexDiagnostics: { byTier: { exact: 20, repeated: 38, phrase: 6, ai: 0 } } }) });
  try {
    assert.equal(app.get('flow-counts').textContent, '收到 94 · 计入 64 · 未决 4');
    assert.ok(app.get('hex-rule-summary').textContent.includes('重复数字 38'));
    app.events.at(-1).disconnect();
    assert.equal(app.get('flow-counts').textContent, '收到 — · 计入 — · 未决 —');
  } finally { app.dispose(); }
});

test('全部刷新与双选项刷新可见，按完整动作显示领先项', async () => {
  const app = await harness({ pathname:'/panel', state:snapshot({connection:'connected', hex:[
    {key:'d',votes:4}, {key:'12d',votes:2}, {key:'1d',votes:0}, {key:'2d',votes:0},
  ], validMessages:6}) });
  try {
    assert.equal(app.get('hex-count-d').textContent, '4');
    assert.equal(app.get('hex-count-12d').textContent, '2');
    assert.equal(app.get('hex-count-1d').textContent, '0');
    assert.equal(app.get('leader-name').textContent, '全部刷新');
    assert.equal(app.get('leader-name').classList.contains('equipment-leader'), true);
    assert.equal(app.get('hex-option-d').classList.contains('refresh-all'), true);
    assert.equal(app.get('hex-option-12d').classList.contains('refresh-pair'), true);
  } finally { app.dispose(); }
});

test('重开操作台保留实际直播来源页签，显示源接口的直播间编号', async () => {
  const app = await harness({state:snapshot({sourceKind:'live', source:{roomId:510,state:'live'}, connection:'connected'})});
  try {
    assert.equal(app.get('live-controls').hidden, false);
    assert.equal(app.get('replay-controls').hidden, true);
    assert.equal(app.get('live-tab').attributes.get('aria-pressed'), 'true');
    assert.equal(app.get('result-source').textContent, '直播间 510');
  } finally { app.dispose(); }
});

test('待确认原词可展示但不成为首选，断连隐藏，动态词面只用文本', async () => {
  const term = '<img src=x onerror=alert(1)>';
  const app = await harness({pathname:'/panel', state:snapshot({mode:'equipment', connection:'connected',
    equipment:{top3:[], against:[], unknown:[{term, mentions:3}]}, validMessages:0})});
  try {
    assert.equal(app.get('unknown-area').hidden, false);
    assert.ok(app.get('unknown-list').textContent.includes(term));
    assert.ok(app.get('unknown-list').textContent.includes('3 条相关弹幕'));
    assert.equal(app.get('leader-name').textContent, '—');
    app.events.at(-1).disconnect();
    assert.equal(app.get('unknown-area').hidden, true);
  } finally { app.dispose(); }
});

test('装备审计走本机接口，区分首选与未决，模式变化清空旧样本', async () => {
  const app = await harness({state:snapshot({mode:'equipment', connection:'connected'}),
    audit:{roundId:1, samples:[{text:'绿甲', current:['振奋盔甲'], against:[], later:[], alternatives:[], conditional:[], pending:false, via:'local'}]}});
  try {
    await app.get('hex-audit-refresh').fire('click');
    assert.ok(app.fetches.some(row => new URL(row.url).pathname === '/api/equipment-audit'));
    assert.ok(app.get('hex-audit-list').textContent.includes('现在买：振奋盔甲'));
    app.emit(snapshot({roundId:1, mode:'hex', connection:'connected', revision:2}));
    assert.equal(app.get('hex-audit-area').hidden, true);
    assert.equal(app.get('hex-audit-list').children.length, 0);
  } finally { app.dispose(); }
});

test('本机识别样本原文只作为文本显示，换轮清空，只读页不请求样本', async () => {
  const payload = '<img src=x onerror=alert(1)>';
  const app = await harness({ state: snapshot({ connection: 'connected' }),
    audit: { roundId: 1, samples: [{ text: payload, command: '2', tier: 'phrase', reason: 'support' }] } });
  try {
    await app.get('hex-audit-refresh').fire('click');
    assert.ok(app.get('hex-audit-list').textContent.includes(payload));
    assert.equal(app.get('hex-audit-area').hidden, false);
    app.emit(snapshot({ revision: 2, roundId: 2, connection: 'connected' }));
    assert.equal(app.get('hex-audit-area').hidden, true);
    assert.equal(app.get('hex-audit-list').children.length, 0);
  } finally { app.dispose(); }
  const panel = await harness({ pathname: '/panel' });
  try {
    assert.equal(panel.get('hex-audit-refresh').handlers.size, 0);
    assert.equal(panel.fetches.some(row => new URL(row.url).pathname === '/api/hex-audit'), false);
  } finally { panel.dispose(); }
});

test('海克斯和装备 AI 独立切换，模型切换保留另一个开关', async () => {
  const flags = { enabled: false, hexEnabled: false, configured: true, model: 'deepseek-flash' };
  const posts = [];
  const app = await harness({ state: snapshot({ ai: { ...flags } }), onControl: body => {
    posts.push(body);
    for (const field of ['enabled', 'hexEnabled', 'model']) if (body[field] !== undefined) flags[field] = body[field];
    return snapshot({ ai: { ...flags } });
  } });
  try {
    app.get('hex-ai-enabled').checked = true;
    await app.get('hex-ai-enabled').fire('change');
    assert.equal(posts[0].hexEnabled, true);
    assert.equal(posts[0].enabled, undefined);
    assert.equal(app.get('ai-enabled').checked, false);
    app.get('ai-model').value = 'deepseek-v4-pro';
    await app.get('ai-model').fire('change');
    assert.equal(app.get('hex-ai-enabled').checked, true);
    app.get('ai-enabled').checked = true;
    await app.get('ai-enabled').fire('change');
    assert.equal(app.get('hex-ai-enabled').checked, true);
    assert.equal(app.get('ai-enabled').checked, true);
  } finally { app.dispose(); }
});

function staleLoadThenPlay(body, app) {
  if (body.action === 'replay-load') {
    const middle = snapshot({
      revision: 2, roundId: 2, sourceKind: 'replay',
      source: { state: 'paused', dataset: body.dataset, position: body.position, duration: 7213, speed: body.speed },
    });
    app.emit(middle);
    return middle;
  }
  assert.equal(body.action, 'replay-play');
  return snapshot({
    revision: 3, roundId: 3, mode: body.mode, counting: body.counting, seconds: body.seconds,
    remainingMs: body.seconds * 1000, status: 'collecting', connection: 'connected', sourceKind: 'replay',
    source: { state: 'playing', dataset: 'azusa-p3', position: 1580, duration: 7213, speed: 1 },
  });
}

async function choose(app, id, value) {
  app.get(id).value = value;
  await app.get(id).fire('change');
}

test('载入的旧快照不改变播放动作已经选择的 10 秒、装备和匿名口径', async () => {
  const app = await harness({ onControl: staleLoadThenPlay });
  try {
    await choose(app, 'round-seconds', '10');
    await choose(app, 'mode-select', 'equipment');
    await choose(app, 'counting-select', 'anonymous');
    await app.get('replay-play').fire('click');
    const posts = app.fetches.filter(request => request.method === 'POST');
    assert.deepEqual(posts.map(request => request.body.action), ['replay-load', 'replay-play']);
    assert.deepEqual(posts[0].body, { action: 'replay-load', dataset: 'azusa-p3', position: 1480, speed: 1 });
    assert.deepEqual(posts[1].body, { action: 'replay-play', mode: 'equipment', counting: 'anonymous', seconds: 10 });
    assert.equal(posts[1].headers['X-Panel-Control'], '1');
    assert.equal(app.get('round-seconds').value, '10');
    assert.equal(app.get('mode-select').value, 'equipment');
    assert.equal(app.get('counting-select').value, 'anonymous');
  } finally { app.dispose(); }
});

test('普通实时快照不会覆盖尚未提交的轮次草稿', async () => {
  const app = await harness();
  try {
    await choose(app, 'round-seconds', '10');
    await choose(app, 'mode-select', 'equipment');
    await choose(app, 'counting-select', 'anonymous');
    app.emit(snapshot({ revision: 2, roundId: 2, mode: 'hex', counting: 'messages', seconds: 20 }));
    assert.equal(app.get('round-seconds').value, '10');
    assert.equal(app.get('mode-select').value, 'equipment');
    assert.equal(app.get('counting-select').value, 'anonymous');
    assert.equal(app.fetches.filter(request => request.method === 'POST').length, 0);
  } finally { app.dispose(); }
});

test('候选片段保留用户口径和时长，并使用片段的模式及位置', async () => {
  const app = await harness({ onControl: staleLoadThenPlay });
  try {
    await choose(app, 'round-seconds', '10');
    await choose(app, 'counting-select', 'anonymous');
    const candidate = app.get('candidate-windows').children[0];
    assert.ok(candidate.textContent.includes('装备词密集片段'));
    await candidate.fire('click');
    const posts = app.fetches.filter(request => request.method === 'POST');
    assert.equal(posts[0].body.position, 1580);
    assert.deepEqual(posts[1].body, { action: 'replay-play', mode: 'equipment', counting: 'anonymous', seconds: 10 });
  } finally { app.dispose(); }
});

test('关闭 AI 时切换模型不启用 AI，也不被中间快照改回旧模型', async () => {
  const app = await harness({
    state: snapshot({ ai: { enabled: false, configured: true, model: 'deepseek-v4-pro', requests: 0 } }),
    onControl(body, instance) {
      assert.equal(body.action, 'ai');
      instance.emit(snapshot({ revision: 2, ai: { enabled: false, configured: true, model: 'deepseek-v4-pro' } }));
      return snapshot({ revision: 3, ai: { enabled: body.enabled, configured: true, model: body.model } });
    },
  });
  try {
    await choose(app, 'ai-model', 'deepseek-flash');
    const post = app.fetches.find(request => request.method === 'POST');
    assert.deepEqual(post.body, { action: 'ai', enabled: false, model: 'deepseek-flash' });
    assert.equal(app.get('ai-model').value, 'deepseek-flash');
    assert.equal(app.get('ai-enabled').checked, false);
  } finally { app.dispose(); }
});

for (const [name, pathname, token] of [['副屏页', '/panel', ''], ['带配对 token 的页面', '/', 'synthetic-viewer-token']]) {
  test(name + '不绑定操作，也不允许控制请求', async () => {
    const app = await harness({ pathname, token });
    try {
      assert.equal(app.document.body.classList.contains('panel-mode'), true);
      assert.equal(app.get('replay-play').handlers.size, 0);
      assert.equal(app.get('ai-enabled').handlers.size, 0);
      await assert.rejects(app.evaluate('control("round", {mode:"hex",counting:"messages",seconds:10})'), /只读/);
      assert.deepEqual(app.fetches.map(request => new URL(request.url).pathname), ['/api/state']);
      assert.equal(app.fetches.every(request => request.method === 'GET'), true);
      assert.equal(new URL(app.events[0].url).pathname, '/api/events');
      assert.equal(new URL(app.fetches[0].url).searchParams.get('token'), token || null);
      assert.equal(new URL(app.events[0].url).searchParams.get('token'), token || null);
    } finally { app.dispose(); }
  });
}

test('动态装备名称、候选标签及错误只作为文本显示', async () => {
  const payload = '<img src=x onerror="throw 1">';
  const app = await harness({ windows: [{ mode: 'equipment', at: 1580, label: payload }] });
  try {
    assert.ok(app.get('candidate-windows').textContent.includes(payload));
    app.emit(snapshot({
      revision: 2, mode: 'equipment', status: 'collecting', connection: 'connected', remainingMs: 10000,
      equipment: { top3: [{ name: payload, votes: 2 }], against: [{ name: payload, votes: 1 }] },
      error: payload,
    }));
    assert.equal(app.get('leader-name').textContent, payload);
    assert.ok(app.get('equipment-ranking').textContent.includes(payload));
    assert.ok(app.get('against-list').textContent.includes(payload));
    assert.equal(app.get('page-error').textContent, payload);
  } finally { app.dispose(); }
});

test('服务连接中断保留结果，但明确标为过期并停用操作', async () => {
  const app = await harness({ state: snapshot({
    status: 'collecting', connection: 'connected', remainingMs: 10000,
    hex: [{ key: '2', votes: 7 }], validMessages: 7,
  }) });
  try {
    assert.equal(app.get('leader-name').textContent, '2');
    app.events[0].disconnect();
    assert.equal(app.get('leader-name').textContent, '2');
    assert.equal(app.get('round-status-text').textContent, '结果已过期');
    assert.equal(app.get('result-card').classList.contains('outdated'), true);
    assert.equal(app.get('new-round').disabled, true);
    assert.equal(app.get('replay-play').disabled, true);
  } finally { app.dispose(); }
});

test('只读手机页多次从缓存返回时恢复且始终只有一个活动消息流', async () => {
  const app = await harness({ pathname: '/panel', token: 'synthetic-viewer-token', state: snapshot({
    status: 'collecting', connection: 'connected', remainingMs: 10000,
    hex: [{ key: '2', votes: 7 }], validMessages: 7,
  }) });
  try {
    assert.equal(app.events.length, 1);
    assert.equal(app.clockTimers.size, 1);
    app.pageEvent('pageshow', { persisted: false });
    assert.equal(app.events.length, 1, '普通初始显示不应重复订阅');
    for (let index = 0; index < 3; index++) {
      const previous = app.events.at(-1);
      const queuedMessage = previous.onmessage;
      const queuedError = previous.onerror;
      app.pageEvent('pagehide', { persisted: true });
      app.pageEvent('pagehide', { persisted: true });
      assert.equal(previous.closed, true);
      assert.equal(previous.onmessage, null);
      assert.equal(previous.onerror, null);
      assert.equal(app.events.filter(event => !event.closed).length, 0);
      assert.equal(app.clockTimers.size, 0);
      assert.equal(app.get('round-status-text').textContent, '结果已过期');
      app.pageEvent('pageshow', { persisted: true });
      const restored = app.events.at(-1);
      assert.notEqual(restored, previous);
      assert.equal(app.events.length, index + 2);
      assert.equal(app.events.filter(event => !event.closed).length, 1);
      assert.equal(app.clockTimers.size, 1);
      assert.equal(new URL(restored.url).searchParams.get('token'), 'synthetic-viewer-token');
      app.emit(snapshot({
        revision: index + 2, status: 'collecting', connection: 'connected', remainingMs: 10000,
        hex: [{ key: '3', votes: index + 8 }], validMessages: index + 8,
      }));
      assert.equal(app.get('leader-name').textContent, '3');
      assert.equal(app.get('result-card').classList.contains('outdated'), false);
      queuedMessage({ data: JSON.stringify(snapshot({ revision: 999, hex: [{ key: '1', votes: 999 }] })) });
      queuedError({});
      assert.equal(app.get('leader-name').textContent, '3', '已关闭流的迟到回调不得覆盖新结果');
      assert.equal(app.get('result-card').classList.contains('outdated'), false);
      app.pageEvent('pageshow', { persisted: true });
      assert.equal(app.events.length, index + 2, '重复显示事件不得创建第二个消息流');
      assert.equal(app.clockTimers.size, 1);
      assert.equal(app.pageHandlers.get('pagehide').length, 1);
      assert.equal(app.pageHandlers.get('pageshow').length, 1);
    }
    assert.equal(app.fetches.filter(request => request.method === 'POST').length, 0);
    assert.deepEqual(app.fetches.map(request => new URL(request.url).pathname), ['/api/state']);
  } finally { app.dispose(); }
});

test('操作台缓存恢复不重复绑定按钮，也不清除未提交轮次草稿', async () => {
  const app = await harness();
  try {
    await choose(app, 'round-seconds', '10');
    await choose(app, 'counting-select', 'anonymous');
    await choose(app, 'mode-select', 'equipment');
    for (let index = 0; index < 2; index++) {
      app.pageEvent('pagehide', { persisted: true });
      app.pageEvent('pageshow', { persisted: true });
      app.emit(snapshot({ revision: index + 2, roundId: index + 2 }));
      assert.equal(app.get('round-seconds').value, '10');
      assert.equal(app.get('counting-select').value, 'anonymous');
      assert.equal(app.get('mode-select').value, 'equipment');
      assert.equal(app.get('replay-play').handlers.get('click').length, 1);
      assert.equal(app.get('ai-enabled').handlers.get('change').length, 1);
      assert.equal(app.events.filter(event => !event.closed).length, 1);
    }
    assert.equal(app.fetches.filter(request => request.method === 'POST').length, 0);
  } finally { app.dispose(); }
});

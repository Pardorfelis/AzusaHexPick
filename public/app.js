'use strict';

const byId = (id) => document.getElementById(id);
const queryToken = new URLSearchParams(location.search).get('token');
const readOnly = location.pathname === '/panel' || Boolean(queryToken);
const hexOrder = ['1', '2', '3', '1d', '2d', '3d', '12d', '13d', '23d', 'd'];
const hexNames = { '1': '选 1', '2': '选 2', '3': '选 3', '1d': '刷新 1', '2d': '刷新 2', '3d': '刷新 3',
  '12d': '刷新 1＋2', '13d': '刷新 1＋3', '23d': '刷新 2＋3', 'd': '全部刷新' };
let current = null;
let datasets = [];
let serviceOnline = false;
let busy = false;
let selectedSource = 'replay';
let positionDirty = true;
let settingsDirty = false;
let aiDraftDirty = false;
let settingsInitialized = false;
let lastRoundId = null;
let lastReceivedAt = 0;
let lastSnapshotAt = 0;
let lastEquipmentSignature = '';
let clientError = '';
let eventStream = null;
let clockTimer = null;
let pageSuspended = false;
let lifecycleBound = false;
let auditRoundId = null;
let auditMode = null;

function apiUrl(path) {
  const url = new URL(path, location.origin);
  if (queryToken) url.searchParams.set('token', queryToken);
  return url.href;
}

function text(id, value) {
  const element = byId(id);
  const content = String(value ?? '');
  if (element && element.textContent !== content) element.textContent = content;
}

function element(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = String(content);
  return node;
}

function number(value) {
  const result = Number(value);
  return Number.isFinite(result) ? Math.max(0, result) : 0;
}

function formatPosition(value, compact = false) {
  const seconds = Math.floor(number(value));
  const parts = [Math.floor(seconds / 3600), Math.floor(seconds % 3600 / 60), seconds % 60];
  if (compact && !parts[0]) return parts.slice(1).map((part) => String(part).padStart(2, '0')).join('：');
  return parts.map((part) => String(part).padStart(2, '0')).join(compact ? '：' : ':');
}

function parsePosition(value) {
  const cleaned = String(value).trim().replaceAll('：', ':');
  if (!/^\d{1,3}:\d{2}:\d{2}$/.test(cleaned)) throw new Error('开始位置请填写时：分：秒，例如 00:24:40。');
  const [hours, minutes, seconds] = cleaned.split(':').map(Number);
  if (minutes > 59 || seconds > 59) throw new Error('开始位置的分钟和秒数需要在 00～59 之间。');
  const position = hours * 3600 + minutes * 60 + seconds;
  const dataset = datasets.find((item) => item.id === byId('dataset-select').value);
  if (dataset && position >= number(dataset.duration)) throw new Error('开始位置需要早于这段回放的结束时间。');
  return position;
}

function roundOptions() {
  return { mode: byId('mode-select').value, counting: byId('counting-select').value, seconds: Number(byId('round-seconds').value) };
}

function replaySelection() {
  const dataset = byId('dataset-select').value;
  if (!dataset) throw new Error('请先选择一段回放。');
  return {
    dataset,
    position: parsePosition(byId('replay-position').value),
    speed: Number(byId('replay-speed').value),
  };
}

function syncForm(snapshot) {
  if (!snapshot || busy || readOnly) return;
  if (!settingsDirty && (!settingsInitialized || snapshot.roundId !== lastRoundId)) {
    byId('mode-select').value = snapshot.mode === 'equipment' ? 'equipment' : 'hex';
    byId('counting-select').value = snapshot.counting === 'anonymous' ? 'anonymous' : 'messages';
    if ([10, 15, 20, 30, 60].includes(Number(snapshot.seconds))) byId('round-seconds').value = String(snapshot.seconds);
    settingsInitialized = true;
    lastRoundId = snapshot.roundId;
  }
  if (!aiDraftDirty) {
    byId('ai-model').value = snapshot.ai?.model || 'deepseek-v4-pro';
    byId('ai-enabled').checked = Boolean(snapshot.ai?.enabled);
    byId('hex-ai-enabled').checked = Boolean(snapshot.ai?.hexEnabled);
  }
}

async function request(path, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(apiUrl(path), { cache: 'no-store', ...options, signal: controller.signal });
    let value;
    try { value = await response.json(); } catch { throw new Error('服务响应暂时无法读取，请检查操作台是否仍在运行。'); }
    if (!response.ok) throw new Error(value.error || '操作暂时未完成，请稍后重试。');
    return value;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('操作等待时间较长，请检查来源连接。未自动重复操作。');
    if (error instanceof TypeError) throw new Error('暂时连接不到本机服务，请确认建议台已启动。');
    throw error;
  } finally { clearTimeout(timer); }
}

async function control(action, values = {}) {
  if (readOnly) throw new Error('这是只读展示页，请在操作台控制。');
  const snapshot = await request('/api/control', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Panel-Control': '1' },
    body: JSON.stringify({ action, ...values }),
  });
  if (action === 'round' || action === 'replay-play') settingsDirty = false;
  if (action === 'ai') aiDraftDirty = false;
  update(snapshot);
  return snapshot;
}

async function perform(task) {
  if (busy || readOnly) return;
  busy = true;
  clientError = '';
  refreshControls();
  renderError();
  try { await task(); } catch (error) {
    clientError = error.message || '操作未完成，请检查输入。';
    aiDraftDirty = false;
  }
  finally { busy = false; syncForm(current); refreshControls(); renderError(); }
}

function renderError() {
  const error = clientError || current?.error || '';
  byId('page-error').hidden = !error;
  text('page-error', error);
}

function selectSource(kind) {
  selectedSource = kind;
  byId('replay-controls').hidden = kind !== 'replay';
  byId('live-controls').hidden = kind !== 'live';
  for (const tab of ['replay', 'live']) {
    byId(tab + '-tab').classList.toggle('active', tab === kind);
    byId(tab + '-tab').setAttribute('aria-pressed', String(tab === kind));
  }
  refreshControls();
}

function refreshControls() {
  if (readOnly) return;
  const blocked = busy || !serviceOnline;
  document.querySelectorAll('.operator-only button, .operator-only input, .operator-only select').forEach((node) => { node.disabled = blocked || node.dataset.copying === 'true'; });
  const noReplay = !byId('dataset-select').value;
  for (const id of ['dataset-select', 'replay-position', 'replay-speed', 'replay-load', 'replay-play']) byId(id).disabled = blocked || noReplay;
  byId('replay-pause').disabled = blocked || current?.sourceKind !== 'replay' || current?.source?.state !== 'playing';
  byId('stop-source').disabled = blocked || !current || current.sourceKind === 'none';
  byId('new-round').disabled = blocked || current?.connection !== 'connected';
  byId('lock-round').disabled = blocked || current?.status !== 'collecting';
  const aiBlocked = blocked || !current?.ai?.configured || Boolean(current?.ai?.costUnknown) || Boolean(current?.ai?.busy);
  byId('ai-enabled').disabled = aiBlocked;
  byId('hex-ai-enabled').disabled = aiBlocked;
  byId('ai-model').disabled = blocked || Boolean(current?.ai?.busy);
  text('replay-play', busy ? '正在操作…' : '播放并开始新轮');
}

function renderCandidates() {
  const dataset = datasets.find((item) => item.id === byId('dataset-select').value);
  byId('candidate-windows').replaceChildren();
  if (!dataset) return;
  text('dataset-description', `${number(dataset.count).toLocaleString('zh-CN')} 条文件弹幕 · 时长 ${formatPosition(dataset.duration, true)}`);
  for (const candidate of Array.isArray(dataset.windows) ? dataset.windows : []) {
    const button = element('button', 'candidate-button');
    button.type = 'button';
    button.append(element('span', 'candidate-time', formatPosition(candidate.at, true)), element('span', '', candidate.label || (candidate.mode === 'hex' ? '数字建议片段' : '装备建议片段')));
    button.addEventListener('click', () => perform(async () => {
      byId('replay-position').value = formatPosition(candidate.at);
      byId('mode-select').value = candidate.mode === 'equipment' ? 'equipment' : 'hex';
      positionDirty = true;
      settingsDirty = true;
      const selection = replaySelection();
      const options = roundOptions();
      await loadReplay(selection);
      await control('replay-play', options);
    }));
    byId('candidate-windows').append(button);
  }
  if (!dataset.windows?.length) byId('candidate-windows').append(element('span', 'field-hint', '这段回放暂无候选片段，可以填写开始位置。'));
  refreshControls();
}

async function loadPhoneState() {
  if (readOnly) return;
  try {
    const health = await request('/api/health');
    byId('phone-links').replaceChildren();
    if (!health.lanEnabled) {
      text('phone-status', '手机模式未开启。可用启动脚本的手机模式启用。');
      byId('phone-note').hidden = true;
      return;
    }
    const links = Array.isArray(health.viewerUrls) ? health.viewerUrls : [];
    text('phone-status', links.length ? '手机模式已开启。将下方配对地址发到自己的手机后打开。' : '手机模式已开启，暂未找到可用的局域网地址。');
    byId('phone-note').hidden = !links.length;
    for (const address of links) {
      let url;
      try { url = new URL(address); } catch { continue; }
      if (url.protocol !== 'http:' || url.pathname !== '/panel' || !url.searchParams.get('token')) continue;
      const row = element('div', 'phone-link-row');
      const link = element('a', 'phone-link', url.hostname + ' · 打开手机只读页');
      link.href = url.href;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      const copy = element('button', 'button secondary phone-copy', '复制配对地址');
      copy.type = 'button';
      copy.addEventListener('click', async () => {
        if (copy.disabled) return;
        copy.dataset.copying = 'true';
        copy.disabled = true;
        try {
          await navigator.clipboard.writeText(url.href);
          copy.textContent = '已复制';
        } catch {
          clientError = '暂时无法自动复制。可以右键配对链接复制地址。';
          renderError();
        } finally {
          setTimeout(() => { delete copy.dataset.copying; copy.textContent = '复制配对地址'; refreshControls(); }, 1400);
        }
      });
      row.append(link, copy);
      byId('phone-links').append(row);
    }
  } catch (error) { text('phone-status', error.message || '手机模式状态暂时无法读取。'); }
}

async function loadReplay(selection = replaySelection()) {
  await control('replay-load', selection);
  byId('replay-position').value = formatPosition(selection.position);
  positionDirty = false;
}

function update(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return;
  if (serviceOnline && current && Number.isFinite(snapshot.revision) && Number.isFinite(current.revision) && snapshot.revision < current.revision) return;
  current = snapshot;
  lastReceivedAt = performance.now();
  lastSnapshotAt = number(snapshot.now);
  serviceOnline = true;
  syncForm(snapshot);
  render();
  refreshControls();
}

function sourceLabel() {
  if (!current) return '未接入来源';
  if (current.sourceKind === 'replay') return current.source?.label || datasets.find((item) => item.id === current.source?.dataset)?.label || '回放';
  if (current.sourceKind === 'live') {
    const room = current.source?.roomId ?? current.source?.room;
    return room ? `直播间 ${room}` : '直播间';
  }
  return '未接入来源';
}

function renderHex(rows, maximum) {
  for (const key of hexOrder) {
    const row = rows.find((item) => item.key === key);
    const votes = number(row?.votes);
    text('hex-count-' + key, votes);
    byId('hex-option-' + key).classList.toggle('leading', maximum > 0 && votes === maximum);
  }
}

function renderEquipment(top3, against, unknown) {
  const signature = JSON.stringify([top3, against, unknown]);
  if (signature === lastEquipmentSignature) return;
  lastEquipmentSignature = signature;
  const list = byId('equipment-ranking');
  list.replaceChildren();
  const maximum = Math.max(0, ...top3.map((item) => number(item.votes)));
  top3.forEach((item, index) => {
    const row = element('div', 'equipment-row' + (number(item.votes) === maximum ? ' leading' : ''));
    row.append(element('span', 'equipment-rank', String(index + 1).padStart(2, '0')), element('span', 'equipment-name', item.name), element('span', 'equipment-count', number(item.votes)));
    list.append(row);
  });
  if (!top3.length) list.append(element('div', 'equipment-empty', '还没有识别到明确的当前购买建议'));
  byId('against-area').hidden = !against.length;
  byId('against-list').replaceChildren(...against.map((item) => element('span', 'against-item', `${item.name} · ${number(item.votes)}`)));
  byId('unknown-area').hidden = !unknown.length;
  byId('unknown-list').replaceChildren(...unknown.slice(0, 3).map(item => {
    const row = element('div', 'unknown-item');
    row.append(element('span', 'unknown-term', item.term),
      element('span', 'unknown-count', `${number(item.mentions)} ${current.counting === 'anonymous' ? '个匿名标识' : '条相关弹幕'}`));
    return row;
  }));
}

function renderClock() {
  if (!current) return;
  const elapsed = Math.max(0, performance.now() - lastReceivedAt);
  const isStale = !serviceOnline || elapsed > 5000;
  const collecting = current.status === 'collecting' && !isStale;
  const remaining = Math.max(0, number(current.remainingMs) - elapsed);
  let label = current.status === 'locked' ? '已锁定' : current.status === 'paused' ? '已暂停' : '尚未开始';
  if (collecting) label = remaining > 0 ? `收集中 · ${Math.ceil(remaining / 1000)} 秒` : '本轮结束';
  if (isStale) label = '结果已过期';
  text('round-status-text', label);
  byId('round-status').classList.toggle('collecting', collecting && remaining > 0);
  byId('round-status').classList.toggle('stale', isStale);
  byId('result-card').classList.toggle('outdated', isStale);
  const age = current.latestUpdateAt ? Math.max(0, (lastSnapshotAt + elapsed - number(current.latestUpdateAt)) / 1000) : null;
  text('freshness-label', isStale ? '等待重新连接' : age === null ? '等待有效建议' : age < 2 ? '刚刚更新' : `${Math.floor(age)} 秒前更新`);
}

function render() {
  text('service-text', serviceOnline ? '服务已连接' : '连接已断开');
  byId('service-dot').className = 'status-dot ' + (serviceOnline ? 'good' : 'bad');
  if (!current) { renderError(); return; }
  const equipmentMode = current.mode === 'equipment';
  text('result-title', equipmentMode ? '出装建议' : '海克斯技能');
  text('round-label', number(current.roundId) ? `第 ${current.roundId} 轮` : '尚未开始一轮');
  text('result-source', sourceLabel());
  text('counting-label', current.countingLabel || '有效弹幕条数');
  text('valid-count', `${number(current.validMessages)} 条有效建议`);
  text('flow-counts', serviceOnline && current.connection === 'connected'
    ? `收到 ${number(current.receivedMessages)} · 计入 ${number(current.validMessages)} · 未决 ${number(current.pendingTotal ?? current.pendingCount)}`
    : '收到 — · 计入 — · 未决 —');
  const tiers = current.hexDiagnostics?.byTier || {};
  const equipmentTiers = current.equipmentDiagnostics?.byTier || {};
  text('hex-rule-summary', equipmentMode ? `本地明确分类 ${number(equipmentTiers.local)} · AI ${number(equipmentTiers.ai)}，前三项仅显示当前购买。`
    : `纯指令 ${number(tiers.exact)} · 重复数字 ${number(tiers.repeated)} · 明确短句 ${number(tiers.phrase)} · AI ${number(tiers.ai)}`);
  if (auditRoundId !== null && (auditRoundId !== current.roundId || auditMode !== current.mode)) {
    byId('hex-audit-area').hidden = true;
    byId('hex-audit-list').replaceChildren();
    auditRoundId = null;
    auditMode = null;
  }
  byId('hex-results').hidden = equipmentMode;
  byId('equipment-results').hidden = !equipmentMode;
  const rows = equipmentMode ? (current.equipment?.top3 || []) : (current.hex || []);
  const maximum = Math.max(0, ...rows.map((item) => number(item.votes)));
  const leaders = maximum > 0 ? rows.filter((item) => number(item.votes) === maximum) : [];
  const name = leaders.map((item) => equipmentMode ? item.name : item.key.endsWith('d') ? hexNames[item.key] : item.key).join('、');
  text('leader-caption', maximum > 0 ? leaders.length > 1 ? equipmentMode ? '前三项中支持并列最多' : '弹幕支持并列最多' : '弹幕支持最多' : current.status === 'collecting' ? '正在等待有效建议' : '等待弹幕建议');
  text('leader-name', name || '—');
  byId('leader-name').classList.toggle('equipment-leader', equipmentMode || leaders.some(item => item.key?.endsWith('d')));
  byId('leader-name').classList.toggle('tie', leaders.length > 1);
  const voteUnit = current.counting === 'anonymous' ? '个匿名标识' : '条弹幕';
  text('leader-detail', maximum > 0 ? `每项 ${maximum} ${voteUnit}${leaders.length > 1 ? ' · 暂无单一领先项' : ''}` : current.status === 'collecting' ? '已收到的明确建议会立即显示。' : '开始一轮后，结果会在这里更新。');
  if (equipmentMode) renderEquipment(rows, current.equipment?.against || [],
    current.connection === 'connected' && serviceOnline ? current.equipment?.unknown || [] : []);
  else renderHex(rows, maximum);
  text('pending-count', number(current.pendingTotal ?? current.pendingCount));
  const supported = Array.isArray(current.supportedEquipment) ? current.supportedEquipment.length : number(current.supportedEquipment) || 12;
  text('equipment-scope', `已载入 ${supported} 个装备正式名及常用别名；未判断当前模式可购买性。待确认词不加入确定支持票。`);
  const connected = current.connection === 'connected';
  let connectionText = connected ? current.sourceKind === 'replay' ? '回放接收正常' : '直播接收正常' : current.connection === 'connecting' ? '正在接入来源' : current.connection === 'error' ? '来源连接异常' : current.sourceKind === 'replay' ? '回放已暂停' : '来源未连接';
  if (!serviceOnline) connectionText = '服务已断开';
  text('connection-label', connectionText);
  byId('connection-dot').className = 'status-dot ' + (connected && serviceOnline ? 'good' : current.connection === 'connecting' ? 'waiting' : current.connection === 'error' ? 'bad' : '');
  const warning = !serviceOnline ? '服务连接中断，保留的结果已过期。' : current.connection === 'error' ? '来源连接异常，当前结果不再更新。' : current.status === 'paused' || (current.sourceKind === 'replay' && current.source?.state === 'paused' && current.roundId) ? '来源暂停，结果保留供回看。请重新开始一轮。' : '';
  byId('result-warning').hidden = !warning;
  text('result-warning', warning);
  byId('identity-warning').hidden = current.counting !== 'anonymous' || !number(current.missingIdentityMessages);
  text('identity-warning', `${number(current.missingIdentityMessages)} 条建议缺少匿名标识，未计入去重结果。`);
  byId('capacity-warning').hidden = !current.capacityLimited;
  text('helper-status', current.helperConnected ? '助手已连接' : '助手未启动');
  byId('helper-status').classList.toggle('ready', Boolean(current.helperConnected));
  text('key-status', current.ai?.configured ? '本机密钥已配置' : '本机尚未配置密钥');
  byId('key-status').classList.toggle('ready', Boolean(current.ai?.configured));
  const cost = current.ai?.costUnknown ? '费用暂时未知' : `高峰价格估算 ${number(current.ai?.estimatedPeakCostCny).toFixed(4)} 元`;
  text('ai-summary', `${current.ai?.busy ? '正在整理复杂建议' : `装备 AI ${current.ai?.enabled ? '开' : '关'} · 海克斯 AI ${current.ai?.hexEnabled ? '开' : '关'}`} · 本轮 ${number(current.ai?.roundRequests)}／4 次 · 累计 ${number(current.ai?.requests)} 次 · ${cost}`);
  text('equipment-ai-policy', current.ai?.equipmentPolicy?.message || '装备明确建议先由本地识别，复杂表达可由 AI 补充。');
  const equipmentPolicy = current.ai?.equipmentPolicy || {};
  byId('equipment-ai-diagnostics').hidden = !equipmentMode;
  text('equipment-ai-diagnostics', `本轮 AI 回填 ${number(equipmentPolicy.appliedCount)} 条 · 有效分类 ${number(equipmentPolicy.countedCount)} 条 · 仍未决 ${number(equipmentPolicy.unresolvedCount)} 条 · 缓存复用 ${number(equipmentPolicy.cacheHits)} 条。有效分类包括反对、后续和备选。`);
  const hexPolicy = current.ai?.hexPolicy || {};
  const policies = { off: '海克斯 AI 已关闭。', waiting: '先收集明确建议，仅末段评估未决表达。',
    'enough-local': `本地明确建议已达到 ${number(hexPolicy.minimumLocalVotes) || 20} 条，跳过海克斯 AI。`,
    active: '仅补充近期数字相关的复杂表达。', 'no-pending': '没有可处理的近期未决数字建议。',
    deadline: '本轮已结束或时间不足，不再调用海克斯 AI。' };
  text('hex-ai-policy', policies[hexPolicy.status] || policies.off);
  byId('ai-error').hidden = !current.ai?.error;
  text('ai-error', current.ai?.error || '');
  if (current.sourceKind === 'replay') text('source-progress', `${sourceLabel()} · ${formatPosition(current.source?.position, true)}／${formatPosition(current.source?.duration, true)} · ${number(current.source?.speed) || 1} 倍`);
  else if (current.sourceKind === 'live') text('source-progress', `${sourceLabel()} · ${connectionText}`);
  else text('source-progress', '尚未选择来源');
  renderClock();
  renderError();
}

function bindControls() {
  byId('hex-audit-refresh').addEventListener('click', () => perform(async () => {
    const mode = current?.mode;
    const audit = await request(mode === 'equipment' ? '/api/equipment-audit' : '/api/hex-audit');
    if (audit.roundId !== current?.roundId || current?.mode !== mode) throw new Error('轮次已变化，请重新查看识别依据。');
    const reasons = { support: '已计入', ambiguous: '未决', against: '反对，不加支持票', multi: '多选或动作混合',
      retrospective: '回顾，不计当前建议', ordinary: '普通数字聊天', superseded: '已有更新建议，旧解释不采用', ai: 'AI 确认' };
    const tiers = { exact: '纯指令', repeated: '重复数字', phrase: '明确短句', ai: 'AI' };
    const samples = Array.isArray(audit.samples) ? audit.samples.slice(-20) : [];
    byId('hex-audit-list').replaceChildren(...samples.map(row => {
      const item = element('li', 'hex-audit-item');
      const categories = [['current', '现在买'], ['against', '反对'], ['later', '后续'], ['alternatives', '备选'], ['conditional', '条件']];
      const equipmentLabel = categories.filter(([key]) => row[key]?.length)
        .map(([key, label]) => label + '：' + row[key].join('、')).join('；');
      const label = mode === 'equipment'
        ? (row.reason === 'superseded' ? reasons.superseded : equipmentLabel || (row.pending ? '未决，暂不计入当前购买' : '未计入')) + ` · ${row.via === 'ai' ? 'AI' : '本地'}`
        : row.command ? `${hexNames[row.command] || row.command} · ${tiers[row.tier] || '识别'}` : reasons[row.reason] || '未计入';
      item.append(element('span', 'hex-audit-label', label), element('span', 'hex-audit-text', String(row.text ?? '') + (row.truncated ? '…' : '')));
      return item;
    }));
    auditRoundId = audit.roundId;
    auditMode = mode;
    text('hex-audit-status', samples.length ? `最近最多 20 条${mode === 'equipment' ? '装备' : '数字及刷新'}相关样本，仅本机可读；不是完整日志。` : '本轮暂无相关识别样本。');
    byId('hex-audit-area').hidden = false;
  }));
  byId('replay-tab').addEventListener('click', () => selectSource('replay'));
  byId('live-tab').addEventListener('click', () => selectSource('live'));
  byId('dataset-select').addEventListener('change', () => { positionDirty = true; renderCandidates(); });
  byId('replay-position').addEventListener('input', () => { positionDirty = true; });
  byId('replay-speed').addEventListener('change', () => { positionDirty = true; });
  for (const id of ['mode-select', 'round-seconds', 'counting-select']) byId(id).addEventListener('change', () => { settingsDirty = true; });
  byId('replay-load').addEventListener('click', () => perform(() => loadReplay(replaySelection())));
  byId('replay-play').addEventListener('click', () => perform(async () => {
    const selection = replaySelection();
    const options = roundOptions();
    const shouldLoad = current?.sourceKind !== 'replay' || current.source?.dataset !== selection.dataset || positionDirty;
    if (shouldLoad) await loadReplay(selection);
    await control('replay-play', options);
  }));
  byId('replay-pause').addEventListener('click', () => perform(async () => {
    const snapshot = await control('replay-pause');
    byId('replay-position').value = formatPosition(snapshot.source?.position);
    positionDirty = false;
  }));
  byId('live-connect').addEventListener('click', () => perform(async () => {
    const room = byId('room-input').value.trim();
    if (!/^\d{1,10}$/.test(room) || Number(room) < 1) throw new Error('请填写有效的数字直播间号。');
    await control('live', { room: Number(room) });
  }));
  byId('stop-source').addEventListener('click', () => perform(() => control('stop')));
  byId('new-round').addEventListener('click', () => perform(() => {
    const options = roundOptions();
    return control('round', options);
  }));
  byId('lock-round').addEventListener('click', () => perform(() => control('lock')));
  byId('ai-enabled').addEventListener('change', () => perform(() => {
    aiDraftDirty = true;
    const selection = { enabled: byId('ai-enabled').checked, model: byId('ai-model').value };
    return control('ai', selection);
  }));
  byId('hex-ai-enabled').addEventListener('change', () => perform(() => {
    aiDraftDirty = true;
    return control('ai', { hexEnabled: byId('hex-ai-enabled').checked, model: byId('ai-model').value });
  }));
  byId('ai-model').addEventListener('change', () => perform(() => {
    aiDraftDirty = true;
    const selection = { enabled: Boolean(current?.ai?.enabled), model: byId('ai-model').value };
    return control('ai', selection);
  }));
}

function disconnectEvents() {
  const previous = eventStream;
  eventStream = null;
  if (previous) {
    previous.onmessage = null;
    previous.onerror = null;
    previous.close();
  }
  if (clockTimer !== null) {
    clearInterval(clockTimer);
    clockTimer = null;
  }
  serviceOnline = false;
  render();
  refreshControls();
}

function connectEvents() {
  if (pageSuspended || eventStream) return;
  const events = new EventSource(apiUrl('/api/events'));
  eventStream = events;
  events.onmessage = (event) => {
    if (eventStream !== events || pageSuspended) return;
    try {
      const snapshot = JSON.parse(event.data);
      if (!serviceOnline) clientError = '';
      update(snapshot);
    } catch { clientError = '结果暂时无法读取，正在等待下一次更新。'; renderError(); }
  };
  events.onerror = () => {
    if (eventStream !== events || pageSuspended) return;
    serviceOnline = false;
    render();
    refreshControls();
  };
  if (clockTimer === null) clockTimer = setInterval(renderClock, 200);
}

function bindPageLifecycle() {
  if (lifecycleBound) return;
  lifecycleBound = true;
  window.addEventListener('pagehide', () => {
    pageSuspended = true;
    disconnectEvents();
  });
  window.addEventListener('pageshow', (event) => {
    if (!event.persisted) return;
    pageSuspended = false;
    connectEvents();
  });
}

async function initialize() {
  bindPageLifecycle();
  if (readOnly) {
    document.body.classList.add('panel-mode');
    document.querySelector('.read-only-caption').hidden = false;
    document.title = '梓有妙选｜Azusa HexPick · 只读副屏';
  } else bindControls();
  byId('panel-link').href = apiUrl('/panel');
  for (const key of hexOrder) {
    const option = element('div', 'hex-option' + (key === 'd' ? ' refresh-all' : key.length === 3 ? ' refresh-pair' : ''));
    option.id = 'hex-option-' + key;
    const count = element('span', 'hex-option-count', '0');
    count.id = 'hex-count-' + key;
    option.append(element('span', 'hex-option-label', hexNames[key]), count);
    byId('hex-results').append(option);
  }
  refreshControls();
  try {
    const initial = await request('/api/state');
    update(initial);
    if (!readOnly) selectSource(initial.sourceKind === 'live' ? 'live' : 'replay');
  } catch (error) { clientError = error.message; renderError(); }
  if (!readOnly) {
    try {
      const values = await request('/api/replays');
      datasets = Array.isArray(values) ? values : [];
      byId('dataset-select').replaceChildren(...datasets.map((item) => {
        const option = element('option', '', item.label || item.id);
        option.value = item.id;
        return option;
      }));
      if (!datasets.length) {
        const emptyOption = element('option', '', '未找到回放弹幕文件');
        emptyOption.value = '';
        byId('dataset-select').append(emptyOption);
      }
      if (current?.sourceKind === 'replay' && datasets.some((item) => item.id === current.source?.dataset)) {
        byId('dataset-select').value = current.source.dataset;
        byId('replay-position').value = formatPosition(current.source.position);
        byId('replay-speed').value = String(current.source.speed);
        positionDirty = false;
      }
      renderCandidates();
    } catch (error) { clientError = error.message; renderError(); }
    await loadPhoneState();
  }
  connectEvents();
}

initialize().catch((error) => { clientError = error.message || '页面尚未准备完成，请重新打开。'; renderError(); });

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import path from 'node:path';

// 旧人工金标保持原件，版本覆盖只采用逐条确认的需求变化。
const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argument = flag => {
  const index = process.argv.indexOf(flag);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new TypeError(`${flag} 必须指定参数。`);
  return value;
};
if (process.argv.includes('--help')) {
  console.log('默认 --profile 0.3，写入 hex-v03-review-result.json。\n--profile 0.2 必须通过 --module 指定旧六动作解析器，写入 hex-v02-rerun-result.json。\n旧 hex-language-cases.json 与 hex-review-result.json 不会覆盖。');
  process.exit(0);
}
const profileVersion = argument('--profile') ?? '0.3';
if (!['0.2', '0.3'].includes(profileVersion)) throw new TypeError('评估 profile 仅支持 0.2 或 0.3。');
const moduleArgument = argument('--module');
if (profileVersion === '0.2' && !moduleArgument) {
  throw new TypeError('0.2 评估必须用 --module 显式指定旧六动作解析器，不能用当前十动作解析器复现旧报告。');
}
const digest = value => createHash('sha256').update(value).digest('hex');
const goldPath = path.join(workspace, 'validation', 'hex-language-cases.json');
const legacyReportPath = path.join(workspace, 'validation', 'hex-review-result.json');
const goldBytes = await readFile(goldPath);
const legacyReportBytes = await readFile(legacyReportPath);
const baseData = JSON.parse(goldBytes.toString('utf8'));
const profilePath = profileVersion === '0.3' ? path.join(workspace, 'validation', 'hex-v03-profile.json') : null;
const profileBytes = profilePath ? await readFile(profilePath) : null;
const profile = profileBytes ? JSON.parse(profileBytes.toString('utf8')) : {
  profileVersion: '0.2', commands: ['1', '2', '3', '1d', '2d', '3d'], overrides: [], windowExpectations: [],
};
if (profile.profileVersion !== profileVersion || !Array.isArray(profile.commands) || !Array.isArray(profile.overrides)) {
  throw new TypeError('人工评估 profile 格式无效。');
}
if (profile.baseGoldSha256 && profile.baseGoldSha256 !== digest(goldBytes)) throw new Error('原始金标 SHA 与人工覆盖表不一致。');
const commands = [...profile.commands];
const permitted = new Set(commands);
if (permitted.size !== commands.length || commands.some(command => typeof command !== 'string')) throw new Error('profile 动作范围无效。');
const oldCases = new Map(baseData.cases.map(sample => [sample.id, sample]));
const overlay = new Map();
for (const override of profile.overrides) {
  const original = oldCases.get(override.id);
  if (!original || overlay.has(override.id)) throw new Error(`人工覆盖编号不存在或重复：${override.id}`);
  if (original.text !== override.textGuard || original.expectedKey !== override.oldExpectedKey
      || original.category !== override.oldCategory || original.coverageTier !== override.oldCoverageTier) {
    throw new Error(`人工覆盖的旧文本或标签不一致：${override.id}`);
  }
  if (!permitted.has(override.expectedKey) || !['exact', 'repeated', 'common', 'contextual', 'rejection'].includes(override.coverageTier)
      || typeof override.category !== 'string' || typeof override.allowPending !== 'boolean' || !override.reason) {
    throw new Error(`人工覆盖的新标签无效：${override.id}`);
  }
  overlay.set(override.id, override);
}
const data = { ...baseData, cases: baseData.cases.map(sample => {
  const override = overlay.get(sample.id);
  return override ? { ...sample, expectedKey: override.expectedKey, category: override.category,
    coverageTier: override.coverageTier, allowPending: override.allowPending } : sample;
}) };
const modulePath = moduleArgument ? path.resolve(moduleArgument) : path.join(workspace, 'src', 'hex.mjs');
let parser;
try {
  parser = await import(pathToFileURL(modulePath).href);
} catch (error) {
  console.error(JSON.stringify({ status: 'not-ready', reason: error.code ?? error.name, module: path.relative(workspace, modulePath) }));
  process.exitCode = 2;
}

if (parser) {
  if (typeof parser.classifyHex !== 'function' || typeof parser.validateHexInterpretation !== 'function') {
    throw new TypeError('hex module must export classifyHex and validateHexInterpretation');
  }
  if (!Array.isArray(parser.HEX_COMMANDS) || parser.HEX_COMMANDS.length !== commands.length
      || parser.HEX_COMMANDS.some(command => !permitted.has(command))) {
    throw new TypeError(profileVersion === '0.2'
      ? '0.2 profile 必须配旧六动作解析器；当前十动作 parser 不兼容旧语义。'
      : '0.3 profile 必须配十动作解析器。');
  }
  const sum = value => Object.values(value).reduce((total, count) => total + count, 0);
  const blank = () => Object.fromEntries(commands.map(command => [command, 0]));
  const add = (counts, command) => { if (permitted.has(command)) counts[command] += 1; };
  const short = text => text.includes('@') ? '［省略无关提及］' : text.length > 120 ? `${text.slice(0, 120)}…` : text;
  const invalidOutputs = [];
  const wrongVotes = [];
  const falseVotes = [];
  const unsafePending = [];
  const missedCommon = [];
  const tiers = {};
  const categories = {};
  const predictions = new Map();
  const realLabels = new Map();
  const ids = new Set();

  const classify = text => {
    try { return parser.classifyHex(text); }
    catch (error) { return { failure: error.name }; }
  };
  const wellFormed = result => result && typeof result === 'object'
    && (result.command === null || permitted.has(result.command))
    && [null, 'exact', 'repeated', 'phrase'].includes(result.tier)
    && typeof result.pending === 'boolean' && typeof result.reason === 'string'
    && (result.candidate === null || permitted.has(result.candidate))
    && (!result.pending || (result.command === null && permitted.has(result.candidate)))
    && (result.command === null ? result.tier === null : (!result.pending && result.tier !== null));

  for (const sample of data.cases) {
    if (ids.has(sample.id)) throw new Error(`Duplicate annotation id: ${sample.id}`);
    ids.add(sample.id);
    if (sample.expectedKey !== null && !permitted.has(sample.expectedKey)) throw new Error(`Invalid gold key: ${sample.id}`);
    const result = classify(sample.text);
    predictions.set(sample.id, result);
    if (sample.source.kind === 'replay') realLabels.set(`${sample.source.dataset}:${sample.source.messageId}`, sample);
    const view = { id: sample.id, text: short(sample.text), source: sample.source, expectedKey: sample.expectedKey,
      category: sample.category, coverageTier: sample.coverageTier,
      actualCommand: result?.command, pending: result?.pending, candidate: result?.candidate, reason: result?.reason };
    if (!wellFormed(result)) { invalidOutputs.push(view); continue; }
    const tier = tiers[sample.coverageTier] ??= { cases: 0, positives: 0, accepted: 0, deferred: 0, rejected: 0, falseVotes: 0 };
    const category = categories[sample.category] ??= { cases: 0, falseVotes: 0, unsafePending: 0 };
    tier.cases += 1;
    category.cases += 1;
    if (sample.expectedKey !== null) {
      tier.positives += 1;
      if (result.command === sample.expectedKey) tier.accepted += 1;
      else if (result.command !== null) wrongVotes.push(view);
      else if (result.pending && result.candidate === sample.expectedKey) tier.deferred += 1;
      else {
        tier.rejected += 1;
        if (['exact', 'repeated', 'common'].includes(sample.coverageTier)) missedCommon.push(view);
      }
      if (result.pending && result.candidate !== sample.expectedKey) unsafePending.push(view);
    } else {
      if (result.command !== null) { falseVotes.push(view); tier.falseVotes += 1; category.falseVotes += 1; }
      if (result.pending && !sample.allowPending) { unsafePending.push(view); category.unsafePending += 1; }
    }
  }

  const datasets = new Map();
  const datasetHashes = {};
  const windows = [];
  for (const window of data.windows) {
    if (!datasets.has(window.dataset)) {
      const bytes = await readFile(path.join(workspace, 'data', 'replays', `${window.dataset}.json`));
      datasets.set(window.dataset, JSON.parse(bytes.toString('utf8')));
      datasetHashes[window.dataset] = digest(bytes);
    }
    const messages = datasets.get(window.dataset).messages.filter(message => window.start <= message.at && message.at < window.end);
    const exact = blank();
    const repeated = blank();
    const direct = blank();
    const pending = blank();
    const semantic = blank();
    const common = blank();
    const anonymousLatest = new Map();
    const issues = [];
    for (const message of messages) {
      const normalized = String(message.text).normalize('NFKC').trim().toLowerCase();
      if (permitted.has(normalized)) add(exact, normalized);
      else if (/^([123])\1+$/.test(normalized)) add(repeated, normalized[0]);
      else if (profileVersion === '0.3' && /^d{2,}$/.test(normalized)) add(repeated, 'd');
      const sample = realLabels.get(`${window.dataset}:${message.id}`);
      const result = sample ? predictions.get(sample.id) : classify(message.text);
      add(semantic, sample?.expectedKey);
      if (sample && ['exact', 'repeated', 'common'].includes(sample.coverageTier)) add(common, sample.expectedKey);
      if (!wellFormed(result)) {
        issues.push({ at: message.at, text: short(message.text), kind: 'invalid-output' });
        continue;
      }
      add(direct, result.command);
      if (permitted.has(result.command) && message.anonymousId) anonymousLatest.set(message.anonymousId, result.command);
      else if (result.reason === 'against' && message.anonymousId) anonymousLatest.delete(message.anonymousId);
      if (result.pending) add(pending, result.candidate);
      if (result.command !== null && result.command !== (sample?.expectedKey ?? null)) {
        issues.push({ at: message.at, text: short(message.text), kind: 'wrong-vote', command: result.command, expectedKey: sample?.expectedKey ?? null });
      }
    }
    const anonymousCounts = blank();
    for (const command of anonymousLatest.values()) add(anonymousCounts, command);
    windows.push({ id: window.id, dataset: window.dataset, start: window.start, end: window.end,
      totalMessages: messages.length, baselineVotes: sum(exact), baselineCounts: exact,
      repeatedOnlyAdditionalVotes: sum(repeated), repeatedOnlyAdditionalCounts: repeated,
      directVotes: sum(direct), directCounts: direct, pendingMessages: sum(pending), pendingCounts: pending,
      anonymousDirectVotes: sum(anonymousCounts), anonymousDirectCounts: anonymousCounts,
      anonymousReferenceNote: '当前本地规则与明确反对撤回语义下的匿名标识参考，不是精确人数，也未包含 AI 回填。',
      commonPositiveReference: sum(common), commonPositiveCounts: common,
      semanticPositiveReference: sum(semantic), semanticPositiveCounts: semantic,
      issues });
  }

  // 检查格式校验，不执行任何模型请求。
  const validationCases = [
    ...commands.map(command => ({ value: { command, uncertain: false }, valid: true })),
    ...['d', '12d', '13d', '23d'].filter(command => !permitted.has(command))
      .map(command => ({ value: { command, uncertain: false }, valid: false })),
    { value: { command: null, uncertain: true }, valid: true },
    { value: { command: '2', uncertain: true }, valid: false },
    { value: { command: null, uncertain: false }, valid: false },
    { value: { command: '4', uncertain: false }, valid: false },
    { value: { command: '123d', uncertain: false }, valid: false },
    { value: { command: '21d', uncertain: false }, valid: false },
    { value: { command: '2' }, valid: false },
    { value: { command: '2', uncertain: false, instruction: 'override' }, valid: false },
    { value: { command: '2', uncertain: 'false' }, valid: false },
    { value: null, valid: false },
    { value: ['2'], valid: false },
  ];
  const validatorFailures = [];
  for (const item of validationCases) {
    let result;
    try { result = parser.validateHexInterpretation(item.value); }
    catch { validatorFailures.push({ value: item.value, kind: 'throw' }); continue; }
    const accepted = result !== null && result !== false && result !== undefined;
    if (accepted !== item.valid) validatorFailures.push({ value: item.value, expectedAccepted: item.valid, actualAccepted: accepted });
    else if (item.valid && (typeof result !== 'object' || result.command !== item.value.command || result.uncertain !== item.value.uncertain)) {
      validatorFailures.push({ value: item.value, kind: 'changed-valid-value' });
    }
  }
  const actionRangeChecks = commands.map(command => {
    const result = classify(command);
    return { text: command, expectedKey: command, actualCommand: result?.command, reason: result?.reason,
      passed: wellFormed(result) && result.command === command && !result.pending };
  });
  const rangeFailures = actionRangeChecks.filter(item => !item.passed);
  const windowRegressions = [];
  const specifiedWindows = (profile.windowExpectations ?? []).map(expectation => {
    const actual = windows.find(window => window.id === expectation.id);
    if (!actual) throw new Error(`指定回放窗口不存在：${expectation.id}`);
    const passed = actual.directVotes === expectation.directVotes;
    const comparison = { id: expectation.id, expectedDirectVotes: expectation.directVotes,
      actualDirectVotes: actual.directVotes, passed, reason: expectation.reason };
    if (!passed) windowRegressions.push(comparison);
    return comparison;
  });
  const directFailures = invalidOutputs.length + wrongVotes.length + falseVotes.length + validatorFailures.length + rangeFailures.length;
  const candidateTypeFailures = unsafePending.filter(item => item.expectedKey !== null).length;
  const rejectionPendingFailures = unsafePending.filter(item => item.expectedKey === null).length;
  const criticalFailures = directFailures + candidateTypeFailures;
  const qualityFailures = criticalFailures + rejectionPendingFailures + windowRegressions.length;
  const inputsUnchanged = digest(await readFile(goldPath)) === digest(goldBytes)
    && digest(await readFile(legacyReportPath)) === digest(legacyReportBytes);
  if (!inputsUnchanged) throw new Error('评估期间原金标或旧报告发生变化，停止写入新报告。');
  const report = { schemaVersion: 2, profileVersion, generatedAt: new Date().toISOString(), cases: data.cases.length,
    commands, manualOverlayCount: overlay.size, unchangedOriginalCases: data.cases.length - overlay.size,
    appliedOverrides: profile.overrides,
    provenance: {
      originalGold: { path: path.relative(workspace, goldPath), sha256: digest(goldBytes) },
      oldReport: { path: path.relative(workspace, legacyReportPath), sha256: digest(legacyReportBytes) },
      profile: profilePath ? { path: path.relative(workspace, profilePath), sha256: digest(profileBytes) } : { inlineVersion: '0.2', manualOverlayCount: 0 },
      effectiveCasesSha256: digest(JSON.stringify(data.cases)),
      parser: { path: path.relative(workspace, modulePath), sha256: digest(await readFile(modulePath)) },
      runner: { path: path.relative(workspace, fileURLToPath(import.meta.url)), sha256: digest(await readFile(fileURLToPath(import.meta.url))) },
      replayDatasetSha256: datasetHashes, historicalInputsUnchanged: inputsUnchanged,
    },
    status: qualityFailures === 0 ? 'no-unsafe-result-observed' : 'needs-review',
    directFailures, candidateTypeFailures, rejectionPendingFailures, criticalFailures, qualityFailures,
    invalidOutputs, wrongVotes, falseVotes, unsafePending, validatorFailures,
    actionRangeChecks, rangeFailures, specifiedWindows, windowRegressions,
    tiers, categories, missedCommon, windows,
    limitations: ['这里只评估本地纯规则解析器，没有调用付费模型。', 'pending 不是有效票，也不代表模型已经确认。',
      '扩展语义参考不是应强制全部识别的要求。', '有限标注集不能证明真实直播中不会误判。',
      '0.3 仅对 14 条已确认的新动作语义使用人工覆盖，不能将其当作原始 0.2 结果。',
      '0.2 必须使用旧六动作解析器与旧金标；新十动作解析器不能复现其语义。',
      '历史回放窗口计数不能证明平台弹幕全量送达、游戏画面同步或长期连接稳定。',
      '精确字面基线仅做 NFKC、首尾空白和大小写处理，不等于全部自然语言覆盖。'] };
  const reportPath = path.join(workspace, 'validation', profileVersion === '0.3' ? 'hex-v03-review-result.json' : 'hex-v02-rerun-result.json');
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  const recallGroups = Object.fromEntries(Object.entries(tiers).map(([tier, value]) => [tier, {
    cases: value.cases, positives: value.positives, accepted: value.accepted,
    deferred: value.deferred, rejected: value.rejected,
    directRecall: value.positives ? Number((value.accepted / value.positives).toFixed(4)) : null,
  }]));
  process.stdout.write(`${JSON.stringify({ profileVersion, cases: report.cases, status: report.status, manualOverlayCount: overlay.size,
    directFailures, candidateTypeFailures, rejectionPendingFailures, recallGroups,
    specifiedWindows, rangeFailures: rangeFailures.length, historicalInputsUnchanged: inputsUnchanged,
    report: path.relative(workspace, reportPath),
  }, null, 2)}\n`);
  if (qualityFailures !== 0) process.exitCode = 1;
}

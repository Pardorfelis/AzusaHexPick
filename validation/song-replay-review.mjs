import { readFileSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { PanelEngine } from '../src/engine.mjs';
import { classifySongRequests, SONG_CATALOG_META } from '../src/songs.mjs';

const datasets = ['azusa-singing-p1', 'azusa-singing-p2'].map(id =>
  JSON.parse(readFileSync(new URL(`../data/replays/${id}.json`, import.meta.url), 'utf8')));
const bins = [];
const windows = [];

for (const data of datasets) {
  const groups = new Map();
  const relevant = data.messages.filter(row => row.at >= data.singingStartAt);
  for (const row of relevant) {
    const songs = classifySongRequests(row.text).songs;
    const start = Math.floor(row.at / 30) * 30;
    const group = groups.get(start) ?? { start, received: 0, recognized: 0, requests: 0 };
    group.received += 1;
    if (songs.length) group.recognized += 1;
    group.requests += songs.length;
    groups.set(start, group);
  }
  const dense = [...groups.values()].sort((a, b) => b.requests - a.requests || a.start - b.start).slice(0, 5);
  bins.push({ id: data.id, singingMessages: relevant.length, dense30SecondBins: dense });
  const starts = [...new Set([data.singingStartAt, ...dense.slice(0, 2).map(row => row.start)])];
  for (const start of starts) {
    let now = 1000;
    const engine = new PanelEngine({ now: () => now });
    engine.setConnection('connected', 'replay:' + data.id);
    engine.startRound({ mode: 'songs', counting: 'messages', seconds: 30 });
    for (const row of relevant.filter(row => row.at >= start && row.at < start + 30)) {
      now = 1000 + (row.at - start) * 1000;
      engine.ingest({ ...row, at: now, replayAt: row.at, source: engine.source });
    }
    const before = engine.snapshot();
    const target = before.songs.items.find(row => row.known);
    let grayCheck = null;
    if (target) {
      engine.addSongGray(target.key, before.roundId);
      const hiddenNow = !engine.snapshot().songs.items.some(row => row.key === target.key);
      now += 31000;
      engine.startRound({ mode: 'songs', seconds: 30 });
      engine.ingest({ id: 'gray-check', text: target.title, at: now });
      const filteredNextRound = engine.snapshot().validMessages === 0 && engine.snapshot().songs.excludedRequests === 1;
      engine.resetSongSession();
      engine.startRound({ mode: 'songs', seconds: 30 });
      engine.ingest({ id: 'session-check', text: '想听' + target.title, at: now });
      const restoredNextSession = engine.snapshot().songs.singles.some(row => row.key === target.key);
      grayCheck = { title: target.title, hiddenNow, filteredNextRound, restoredNextSession };
      if (!hiddenNow || !filteredNextRound || !restoredNextSession) throw new Error('真实歌曲名单状态复核失败。');
    }
    windows.push({ id: data.id, start, seconds: 30, receivedMessages: before.receivedMessages,
      recognizedMessages: before.validMessages, totalSongRequests: before.songs.totalRequests,
      mainSongs: before.songs.items.length, singleCandidates: before.songs.singles.length,
      hiddenBareSingles: before.songs.hiddenSingles, topObserved: before.songs.items.slice(0, 8), grayCheck });
  }
  data.windows = [{ mode: 'songs', at: data.singingStartAt, label: '歌回开始位置' },
    ...dense.slice(0, 3).filter(row => row.start !== data.singingStartAt)
      .map(row => ({ mode: 'songs', at: row.start, label: '点歌文字密集片段' }))];
  writeFileSync(new URL(`../data/replays/${data.id}.json`, import.meta.url), JSON.stringify(data), 'utf8');
}

let now = 1000;
const engine = new PanelEngine({ now: () => now });
engine.setConnection('connected', 'clock-simulation');
const started = performance.now();
let messages = 0;
for (let round = 0; round < 360; round++) {
  engine.startRound({ mode: 'songs', seconds: 60 });
  for (let second = 0; second < 60; second++) {
    const text = ['普通朋友', '想听爱情讯息', '哈哈哈', '普通朋友普通朋友'][second % 4];
    engine.ingest({ id: `simulation-${messages++}`, text, at: now, anonymousId: 'same-viewer' });
    now += 1000;
  }
  const state = engine.snapshot();
  if (state.validMessages !== 45 || state.songs.totalRequests !== 45 || state.songs.items.length !== 2)
    throw new Error('模拟轮次计次出现偏差。');
}
const final = engine.snapshot();
const result = { version: '0.4.0', catalogTitles: SONG_CATALOG_META.count, sourceVideo: 'BV1boaW6PEqz',
  scope: '用户提供歌回文件的离线识别分布、名单状态复核及接收时钟模拟；没有观看视频定位主播提问，不代表总体语义准确率。',
  originalXmlModified: false, liveConnections: 0, paidApiCalls: 0, datasets: bins, windows,
  clockSimulation: { representedHours: 6, wallTimeMs: Math.round(performance.now() - started), rounds: 360, messages,
    allRoundCountsMatched: true, dedupEntries: final.dedupEntries, maxDedupEntries: engine.dedupLimit,
    songEntriesLastRound: engine.songMessages.size, pendingRecords: engine.records.size,
    note: '加速的六小时接收时钟检查，不是实际六小时直播或服务器稳定性承诺。' } };
writeFileSync(new URL('./song-replay-review-result.json', import.meta.url), JSON.stringify(result, null, 2), 'utf8');
console.log(JSON.stringify({ catalogTitles: result.catalogTitles, windows: result.windows,
  clockSimulation: result.clockSimulation }));

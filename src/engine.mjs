import { classifyEquipment, extractUnknownEquipmentCandidates, validateInterpretation } from './equipment.mjs';
import { classifyHex, HEX_COMMANDS, validateHexInterpretation } from './hex.mjs';

const HEX = HEX_COMMANDS;
export const HEX_AI_MIN_LOCAL_VOTES = 20;
const labels = { '1': '选择 1', '2': '选择 2', '3': '选择 3', '1d': '刷新 1', '2d': '刷新 2', '3d': '刷新 3',
  'd': '全部刷新', '12d': '刷新 1＋2', '13d': '刷新 1＋3', '23d': '刷新 2＋3' };
const blankCounts = () => Object.fromEntries(HEX.map(key => [key, 0]));
const increment = (map, key, amount = 1) => map.set(key, (map.get(key) ?? 0) + amount);
const hasSuggestion = value => ['current', 'later', 'alternatives', 'against', 'conditional'].some(key => value[key].length);

export class PanelEngine {
  constructor({ now = Date.now, dedupLimit = 20000, aiTimeoutMs = 5000, maxRecords = 2000, maxParticipants = 20000 } = {}) {
    if (typeof now !== 'function') throw new TypeError('now must be a function');
    for (const value of [dedupLimit, aiTimeoutMs, maxRecords, maxParticipants]) {
      if (!Number.isInteger(value) || value < 1) throw new RangeError('Limits must be positive integers');
    }
    this.now = now;
    this.dedupLimit = dedupLimit;
    this.aiTimeoutMs = aiTimeoutMs;
    this.maxRecords = maxRecords;
    this.maxParticipants = maxParticipants;
    this.seen = new Map();
    this.records = new Map();
    this.tickets = new Map();
    this.ticketSequence = 0;
    this.connectionVersion = 0;
    this.source = 'default';
    this.connection = 'disconnected';
    this.roundId = 0;
    this.mode = 'hex';
    this.counting = 'messages';
    this.seconds = 15;
    this.status = 'idle';
    this.startedAt = null;
    this.endsAt = null;
    this.latestUpdateAt = null;
    this._clearRound();
  }

  _clearRound() {
    this.hexMessages = blankCounts();
    this.hexByAnonymous = new Map();
    this.hexAiByAnonymous = new Set();
    this.hexTiers = { exact: 0, repeated: 0, phrase: 0, ai: 0 };
    this.hexIgnored = {};
    this.hexAuditRows = [];
    this.anonymousParticipants = new Set();
    this.equipmentMessages = new Map();
    this.equipmentAgainstMessages = new Map();
    this.equipmentByAnonymous = new Map();
    this.equipmentAuditRows = [];
    this.equipmentIgnored = {};
    this.equipmentTiers = { local: 0, ai: 0 };
    this.revisions = new Map();
    this.records.clear();
    this.tickets.clear();
    this.receivedMessages = 0;
    this.validMessages = 0;
    this.missingIdentityMessages = 0;
    this.evictedPending = 0;
    this.supersededPending = 0;
    this.capacityLimited = false;
  }

  startRound({ mode = this.mode, counting = this.counting, seconds = this.seconds } = {}) {
    if (!['hex', 'equipment'].includes(mode)) throw new RangeError('Unknown mode');
    if (!['messages', 'anonymous'].includes(counting)) throw new RangeError('Unknown counting mode');
    if (!Number.isFinite(seconds) || seconds < 1 || seconds > 300) throw new RangeError('seconds must be between 1 and 300');
    this.mode = mode;
    this.counting = counting;
    this.seconds = seconds;
    this.roundId += 1;
    this._clearRound();
    this.startedAt = this.now();
    this.endsAt = this.startedAt + seconds * 1000;
    this.latestUpdateAt = this.startedAt;
    this.status = this.connection === 'connected' ? 'collecting' : 'paused';
    this.lockReason = null;
    return this.snapshot();
  }

  setConnection(status, source = this.source) {
    if (status && typeof status === 'object') {
      source = status.source ?? source;
      status = status.status;
    }
    if (!['connected', 'connecting', 'disconnected', 'error'].includes(status)) throw new RangeError('Unknown connection status');
    const changedSource = String(source) !== this.source;
    const restored = status === 'connected' && (this.connection !== 'connected' || changedSource);
    this.connection = status;
    this.source = String(source);
    if (restored) {
      this.connectionVersion += 1;
      if (this.roundId > 0) return this.startRound();
    } else if (status !== 'connected' && this.roundId > 0 && this.status !== 'locked') {
      this.status = 'paused';
    }
    return this.snapshot();
  }

  lockRound(reason = 'manual') {
    this._tick();
    if (this.roundId > 0 && this.status !== 'locked') {
      this.status = 'locked';
      this.lockReason = reason;
      this.tickets.clear();
    }
    return this.snapshot();
  }

  _tick() {
    if (this.status === 'collecting' && this.now() >= this.endsAt) {
      this.status = 'locked';
      this.lockReason = 'timeout';
      this.tickets.clear();
    }
    for (const [key, ticket] of this.tickets) {
      if (this.now() >= ticket.expiresAt) {
        const record = this.records.get(ticket.messageKey);
        if (record?.status === 'processing') record.status = 'unresolved';
        this.tickets.delete(key);
      }
    }
  }

  _remember(id) {
    if (this.seen.has(id)) return false;
    this.seen.set(id, true);
    while (this.seen.size > this.dedupLimit) this.seen.delete(this.seen.keys().next().value);
    return true;
  }

  _anonymous(value) {
    if (typeof value !== 'string' || !value.trim() || value.length > 256) return null;
    if (!this.anonymousParticipants.has(value) && this.anonymousParticipants.size >= this.maxParticipants) {
      this.capacityLimited = true;
      return null;
    }
    return value;
  }

  _updateSuggestion(identityKey) {
    if (identityKey.startsWith('anonymous:')) this.anonymousParticipants.add(identityKey.slice('anonymous:'.length));
    const revision = (this.revisions.get(identityKey) ?? 0) + 1;
    this.revisions.set(identityKey, revision);
    for (const record of this.records.values()) {
      if (record.identityKey === identityKey && ['pending', 'processing', 'unresolved'].includes(record.status)) {
        record.status = 'superseded';
        this.supersededPending += 1;
        const audit = this.hexAuditRows.find(row => row.messageKey === record.messageKey);
        if (audit) { audit.pending = false; audit.reason = 'superseded'; }
        const equipmentAudit = this.equipmentAuditRows.find(row => row.messageKey === record.messageKey);
        if (equipmentAudit) { equipmentAudit.pending = false; equipmentAudit.reason = 'superseded'; }
      }
    }
    const previous = this.equipmentByAnonymous.get(identityKey);
    if (previous?.via === 'ai') this.equipmentByAnonymous.delete(identityKey);
    if (this.hexAiByAnonymous.delete(identityKey)) this.hexByAnonymous.delete(identityKey.slice('anonymous:'.length));
    return revision;
  }

  _store(record) {
    this.records.set(record.messageKey, record);
    while (this.records.size > this.maxRecords) {
      const oldest = this.records.keys().next().value;
      const evicted = this.records.get(oldest);
      if (['pending', 'processing', 'unresolved'].includes(evicted.status)) this.evictedPending += 1;
      this.records.delete(oldest);
      if (evicted.identityKey.startsWith('message:')) this.revisions.delete(evicted.identityKey);
      for (const [id, ticket] of this.tickets) if (ticket.messageKey === oldest) this.tickets.delete(id);
    }
  }

  ingest({ id, text, anonymousId = null, at = this.now(), source = this.source, replayAt = null } = {}) {
    this._tick();
    if (this.connection !== 'connected' || this.status !== 'collecting') return { accepted: false, ignoredReason: 'not-collecting' };
    if (String(source) !== this.source) return { accepted: false, ignoredReason: 'old-source' };
    if (typeof id !== 'string' || !id || id.length > 256 || typeof text !== 'string' || text.length > 2000) {
      return { accepted: false, ignoredReason: 'invalid-message' };
    }
    if (!Number.isFinite(at) || at < this.startedAt || at > this.now() + 1000) return { accepted: false, ignoredReason: 'invalid-receive-time' };
    if (!this._remember(id)) return { accepted: false, ignoredReason: 'duplicate-message' };
    this.receivedMessages += 1;
    const anonymous = this._anonymous(anonymousId);
    this.latestUpdateAt = this.now();
    if (this.mode === 'hex') {
      const interpretation = classifyHex(text);
      const identityKey = anonymous ? `anonymous:${anonymous}` : `message:${id}`;
      const record = { messageKey: id, text, anonymousId: anonymous, identityKey, at, replayAt,
        source: this.source, connectionVersion: this.connectionVersion, roundId: this.roundId,
        candidate: interpretation.candidate, mode: 'hex', status: interpretation.pending ? 'pending' : 'resolved' };
      if (interpretation.command || interpretation.pending) {
        record.revision = anonymous || interpretation.pending ? this._updateSuggestion(identityKey) : 0;
        if (interpretation.pending) this._store(record);
      } else if (interpretation.reason === 'against' && anonymous) {
        this._updateSuggestion(identityKey);
        this.hexByAnonymous.delete(anonymous);
      }
      if (interpretation.command) this._applyHexVote(record, interpretation.command, interpretation.tier);
      else if (!interpretation.pending) this.hexIgnored[interpretation.reason] = (this.hexIgnored[interpretation.reason] ?? 0) + 1;
      if (interpretation.command || interpretation.pending || /[123dD]/.test(text.normalize('NFKC')))
        this._auditHex(record, interpretation);
      return { accepted: true, pending: interpretation.pending, command: interpretation.command,
        messageKey: id, ignoredReason: interpretation.command || interpretation.pending ? undefined : interpretation.reason };
    }
    const interpretation = classifyEquipment(text);
    if (!interpretation.recognized && !interpretation.pending) {
      this.equipmentIgnored[interpretation.reason] = (this.equipmentIgnored[interpretation.reason] ?? 0) + 1;
      return { accepted: true, pending: false, ignoredReason: interpretation.reason };
    }
    const identityKey = anonymous ? `anonymous:${anonymous}` : `message:${id}`;
    const revision = this._updateSuggestion(identityKey);
    const record = { messageKey: id, text, anonymousId: anonymous, identityKey, revision, at, replayAt,
      source: this.source, connectionVersion: this.connectionVersion, roundId: this.roundId,
      mode: 'equipment', unknownTerms: interpretation.pending ? extractUnknownEquipmentCandidates(text) : [],
      interpretation: null, status: interpretation.pending ? 'pending' : 'resolved' };
    this._store(record);
    if (!anonymous) this.missingIdentityMessages += 1;
    this._applyInterpretation(record, interpretation, 'local');
    this._auditEquipment(record, interpretation, 'local');
    return { accepted: true, pending: interpretation.pending, messageKey: id };
  }

  _applyHexVote(record, command, tier) {
    this.hexMessages[command] += 1;
    this.validMessages += 1;
    this.hexTiers[tier] += 1;
    if (record.anonymousId) {
      if (this.hexByAnonymous.size < this.maxParticipants || this.hexByAnonymous.has(record.anonymousId)) {
        this.hexByAnonymous.set(record.anonymousId, command);
        if (tier === 'ai') this.hexAiByAnonymous.add(record.identityKey);
        else this.hexAiByAnonymous.delete(record.identityKey);
      } else this.capacityLimited = true;
    } else this.missingIdentityMessages += 1;
    this.latestUpdateAt = this.now();
  }

  _auditHex(record, interpretation) {
    const row = { messageKey: record.messageKey, text: record.text.slice(0, 160), truncated: record.text.length > 160,
      command: interpretation.command, tier: interpretation.tier ?? null, reason: interpretation.reason,
      pending: Boolean(interpretation.pending), at: record.at,
      replayAt: Number.isFinite(record.replayAt) ? record.replayAt : null };
    const existing = this.hexAuditRows.findIndex(item => item.messageKey === record.messageKey);
    if (existing >= 0) this.hexAuditRows[existing] = row;
    else this.hexAuditRows.push(row);
    if (this.hexAuditRows.length > 20) this.hexAuditRows.shift();
  }

  hexAudit() {
    return { roundId: this.roundId, mode: this.mode, limit: 20,
      samples: this.hexAuditRows.map(row => ({ ...row })) };
  }

  _auditEquipment(record, interpretation, via) {
    const row = { messageKey: record.messageKey, text: record.text.slice(0, 160), truncated: record.text.length > 160,
      current: [...interpretation.current], against: [...interpretation.against], later: [...interpretation.later],
      alternatives: [...interpretation.alternatives], conditional: [...interpretation.conditional],
      pending: Boolean(interpretation.pending), reason: interpretation.reason, via, at: record.at,
      replayAt: Number.isFinite(record.replayAt) ? record.replayAt : null };
    const existing = this.equipmentAuditRows.findIndex(item => item.messageKey === record.messageKey);
    if (existing >= 0) this.equipmentAuditRows[existing] = row;
    else this.equipmentAuditRows.push(row);
    if (this.equipmentAuditRows.length > 20) this.equipmentAuditRows.shift();
  }

  equipmentAudit() {
    return { roundId: this.roundId, mode: this.mode, limit: 20,
      samples: this.equipmentAuditRows.map(row => ({ ...row, current: [...row.current], against: [...row.against],
        later: [...row.later], alternatives: [...row.alternatives], conditional: [...row.conditional] })) };
  }

  _unknownEquipment() {
    const groups = new Map();
    for (const record of this.records.values()) {
      if (record.mode !== 'equipment' || !['pending', 'processing', 'unresolved'].includes(record.status)) continue;
      for (const term of record.unknownTerms ?? []) {
        if (!groups.has(term)) groups.set(term, { term, messageMentions: 0, identities: new Set() });
        const group = groups.get(term);
        group.messageMentions += 1;
        if (record.anonymousId) group.identities.add(record.anonymousId);
      }
    }
    return [...groups.values()].map(group => ({ term: group.term, messageMentions: group.messageMentions,
      anonymousMentions: group.identities.size,
      mentions: this.counting === 'messages' ? group.messageMentions : group.identities.size }))
      .filter(group => group.mentions >= 3)
      .sort((a, b) => b.mentions - a.mentions || a.term.localeCompare(b.term, 'zh-CN')).slice(0, 3);
  }

  localHexVotes() { return this.hexTiers.exact + this.hexTiers.repeated + this.hexTiers.phrase; }

  _applyInterpretation(record, interpretation, via) {
    if (record.interpretation) {
      for (const name of record.interpretation.current) increment(this.equipmentMessages, name, -1);
      for (const name of record.interpretation.against) increment(this.equipmentAgainstMessages, name, -1);
      if (hasSuggestion(record.interpretation)) {
        this.validMessages -= 1;
        this.equipmentTiers[record.via ?? 'local'] -= 1;
      }
    }
    record.interpretation = interpretation;
    record.via = via;
    for (const name of interpretation.current) increment(this.equipmentMessages, name);
    for (const name of interpretation.against) increment(this.equipmentAgainstMessages, name);
    if (hasSuggestion(interpretation)) {
      this.validMessages += 1;
      this.equipmentTiers[via] += 1;
      if (record.anonymousId) this.equipmentByAnonymous.set(record.identityKey, { interpretation, via });
    }
    this.latestUpdateAt = this.now();
  }

  listPending(limit = 20) {
    this._tick();
    if (this.status !== 'collecting' || this.connection !== 'connected') return [];
    const now = this.now();
    return [...this.records.values()].filter(record => record.status === 'pending' && record.at + this.aiTimeoutMs > now)
      .slice(0, Math.max(0, Math.min(this.maxRecords, limit))).map(record => ({
      messageKey: record.messageKey, text: record.text, anonymousId: record.anonymousId,
      at: record.at, roundId: record.roundId, revision: record.revision, candidate: record.candidate ?? null,
    }));
  }

  createAiTicket(messageKey) {
    this._tick();
    const record = this.records.get(messageKey);
    if (this.status !== 'collecting' || this.connection !== 'connected' || record?.status !== 'pending'
        || record.revision !== this.revisions.get(record.identityKey)) return null;
    const expiresAt = Math.min(record.at + this.aiTimeoutMs, this.endsAt);
    if (this.now() >= expiresAt) { record.status = 'unresolved'; return null; }
    const ticket = Object.freeze({ id: ++this.ticketSequence, messageKey, roundId: this.roundId,
      source: this.source, connectionVersion: this.connectionVersion, revision: record.revision, expiresAt });
    record.status = 'processing';
    this.tickets.set(ticket.id, ticket);
    return ticket;
  }

  applyAi(ticket, interpretation) {
    this._tick();
    const known = ticket && this.tickets.get(ticket.id);
    const record = known && this.records.get(known.messageKey);
    if (!known || !record || this.status !== 'collecting' || this.connection !== 'connected'
        || known.roundId !== this.roundId || known.source !== this.source || known.connectionVersion !== this.connectionVersion
        || known.revision !== this.revisions.get(record.identityKey) || this.now() >= known.expiresAt
        || record.status !== 'processing') return false;
    const parsed = record.mode === 'hex' ? validateHexInterpretation(interpretation) : validateInterpretation(interpretation);
    this.tickets.delete(known.id);
    if (!parsed) { record.status = 'unresolved'; return false; }
    if (record.mode === 'hex') {
      if (this.localHexVotes() >= HEX_AI_MIN_LOCAL_VOTES || (parsed.command && parsed.command !== record.candidate)) {
        record.status = 'unresolved';
        return false;
      }
      record.status = parsed.uncertain ? 'unresolved' : 'resolved';
      if (parsed.command) this._applyHexVote(record, parsed.command, 'ai');
      this._auditHex(record, { command: parsed.command, tier: parsed.command ? 'ai' : null,
        reason: parsed.command ? 'ai' : 'ambiguous', pending: parsed.uncertain });
      return true;
    }
    record.status = parsed.uncertain ? 'unresolved' : 'resolved';
    this._applyInterpretation(record, parsed, 'ai');
    this._auditEquipment(record, parsed, 'ai');
    return true;
  }

  snapshot() {
    this._tick();
    const anonymousHex = blankCounts();
    for (const command of this.hexByAnonymous.values()) anonymousHex[command] += 1;
    const current = new Map();
    const against = new Map();
    for (const { interpretation } of this.equipmentByAnonymous.values()) {
      for (const name of interpretation.current) increment(current, name);
      for (const name of interpretation.against) increment(against, name);
    }
    const rank = (messages, people) => [...new Set([...messages.keys(), ...people.keys()])].map(name => ({
      name, messageVotes: messages.get(name) ?? 0, anonymousVotes: people.get(name) ?? 0,
      votes: (this.counting === 'messages' ? messages : people).get(name) ?? 0,
    })).filter(item => item.votes > 0).sort((a, b) => b.votes - a.votes || a.name.localeCompare(b.name, 'zh-CN'));
    const pendingCount = [...this.records.values()].filter(record => ['pending', 'processing', 'unresolved'].includes(record.status)).length;
    return {
      roundId: this.roundId, mode: this.mode, counting: this.counting,
      countingLabel: this.counting === 'messages' ? '有效弹幕条数' : '按匿名标识去重（实验）',
      experimentalIdentity: this.counting === 'anonymous', status: this.status, connection: this.connection,
      source: this.source, startedAt: this.startedAt, endsAt: this.endsAt,
      remainingMs: this.endsAt === null ? 0 : Math.max(0, this.endsAt - this.now()),
      seconds: this.seconds, now: this.now(), latestUpdateAt: this.latestUpdateAt, lockReason: this.lockReason ?? null,
      receivedMessages: this.receivedMessages, validMessages: this.validMessages,
      missingIdentityMessages: this.missingIdentityMessages, capacityLimited: this.capacityLimited,
      pendingCount, pendingTotal: pendingCount + this.evictedPending, evictedPending: this.evictedPending,
      supersededPending: this.supersededPending, dedupEntries: this.seen.size,
      hexDiagnostics: { localVotes: this.localHexVotes(), aiVotes: this.hexTiers.ai,
        byTier: { ...this.hexTiers }, ignoredByReason: { ...this.hexIgnored }, pendingCount,
        minimumLocalVotesForSkippingAi: HEX_AI_MIN_LOCAL_VOTES },
      hex: HEX.map(key => ({ key, label: labels[key], votes: this.counting === 'messages' ? this.hexMessages[key] : anonymousHex[key],
        messageVotes: this.hexMessages[key], anonymousVotes: anonymousHex[key] })),
      equipment: { top3: rank(this.equipmentMessages, current).slice(0, 3), against: rank(this.equipmentAgainstMessages, against),
        unknown: this._unknownEquipment() },
      equipmentDiagnostics: { byTier: { ...this.equipmentTiers }, ignoredByReason: { ...this.equipmentIgnored },
        pendingCount, unknownMinimumMentions: 3 },
      limitations: ['纯数字新消息可能回复旧画面，轮次清空不能可靠排除旧票。',
        '匿名标识去重不是精确人数，未获得身份的消息不会计入匿名票。'],
    };
  }
}

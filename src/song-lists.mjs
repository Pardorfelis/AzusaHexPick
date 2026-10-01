import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveSongTitle } from './songs.mjs';

export const SONG_BLACKLIST_TERMS = ['week', 'month', 'quarter', 'half-year', 'year', 'forever'];
const MONTHS = { month: 1, quarter: 3, 'half-year': 6, year: 12 };
const BEIJING_OFFSET = 8 * 3600000;

export function songExpiry(now, term) {
  if (!Number.isFinite(now) || !SONG_BLACKLIST_TERMS.includes(term)) throw new RangeError('拉黑期限无效。');
  if (term === 'forever') return null;
  if (term === 'week') return now + 7 * 86400000;
  const date = new Date(now + BEIJING_OFFSET);
  if (!Number.isFinite(date.getTime())) throw new RangeError('拉黑期限无效。');
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + MONTHS[term]);
  const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, last));
  return date.getTime() - BEIJING_OFFSET;
}

export class SongLists {
  constructor({ path = null, now = Date.now, maxEntries = 1000 } = {}) {
    if (typeof now !== 'function' || !Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > 10000)
      throw new RangeError('歌曲名单参数无效。');
    this.path = path;
    this.now = now;
    this.maxEntries = maxEntries;
    this.gray = new Map();
    this.black = new Map();
    this.sessionId = randomUUID();
    this.warning = '';
    if (path && existsSync(path)) {
      let value;
      try { value = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')); }
      catch { throw new Error('歌曲黑名单文件无法读取，请检查本机文件后重启。'); }
      if (value?.version !== 1 || !Array.isArray(value.entries) || value.entries.length > maxEntries)
        throw new Error('歌曲黑名单格式无效。');
      for (const row of value.entries) {
        const song = resolveSongTitle(row?.title);
        if (!song || row.key !== song.key || !SONG_BLACKLIST_TERMS.includes(row.term)
            || !(row.expiresAt === null && row.term === 'forever'
                 || row.term !== 'forever' && Number.isFinite(row.expiresAt)))
          throw new Error('歌曲黑名单包含无效记录。');
        this.black.set(song.key, { key: song.key, title: song.title, term: row.term, expiresAt: row.expiresAt });
      }
    }
    this._refreshExpiry();
    this.prune();
  }

  _refreshExpiry() {
    this.nextExpiry = Math.min(Infinity, ...[...this.black.values()].map(row => row.expiresAt ?? Infinity));
  }

  _save(next) {
    if (this.path) {
      try {
        mkdirSync(dirname(this.path), { recursive: true });
        const temporary = this.path + '.tmp';
        writeFileSync(temporary, JSON.stringify({ version: 1, entries: [...next.values()] }, null, 2), { encoding: 'utf8', mode: 0o600 });
        renameSync(temporary, this.path);
      } catch { throw new Error('歌曲黑名单未能保存，请检查本机文件写入权限。'); }
    }
    this.black = next;
    this.warning = '';
    this._refreshExpiry();
  }

  prune() {
    if (this.now() < this.nextExpiry) return;
    const next = new Map([...this.black].filter(([, item]) => item.expiresAt === null || item.expiresAt > this.now()));
    if (next.size !== this.black.size) {
      try { this._save(next); }
      catch {
        this.black = next;
        this._refreshExpiry();
        this.warning = '过期歌曲已解除拉黑，但名单文件尚未保存。';
      }
    }
  }

  blocked(key) {
    this.prune();
    return this.gray.has(key) || this.black.has(key);
  }

  addGray(song) {
    if (!song || typeof song.key !== 'string' || typeof song.title !== 'string') throw new Error('歌曲无效。');
    if (!this.gray.has(song.key) && this.gray.size >= this.maxEntries) throw new Error('本场灰名单已达上限。');
    this.gray.set(song.key, { key: song.key, title: song.title });
  }

  removeGray(key) { return this.gray.delete(key); }
  resetSession() { this.gray.clear(); this.sessionId = randomUUID(); }

  addBlack(title, term) {
    const song = resolveSongTitle(title);
    if (!song) throw new Error('请输入有效歌名。');
    const expiresAt = songExpiry(this.now(), term);
    this.prune();
    if (!this.black.has(song.key) && this.black.size >= this.maxEntries) throw new Error('歌曲黑名单已达上限。');
    const next = new Map(this.black);
    next.set(song.key, { key: song.key, title: song.title, term, expiresAt });
    this._save(next);
    return { ...next.get(song.key) };
  }

  removeBlack(key) {
    const next = new Map(this.black);
    const removed = next.delete(key);
    if (removed) this._save(next);
    return removed;
  }

  snapshot() {
    this.prune();
    return { sessionId: this.sessionId, gray: [...this.gray.values()].map(row => ({ ...row })),
      black: [...this.black.values()].map(row => ({ ...row })), warning: this.warning };
  }
}

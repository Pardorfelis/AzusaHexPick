import { readFileSync } from 'node:fs';

const sourceCatalog = JSON.parse(readFileSync(new URL('../data/song-catalog.json', import.meta.url), 'utf8'));
const CATALOG = Symbol('song-catalog');
const MAX_TEXT_LENGTH = 500;
const MAX_TITLE_LENGTH = 80;
const MAX_SONGS = 6;
const ambiguousNames = new Set(['晚安', '好想你', '谢谢', '唯一', '一个人', '讨厌', '谁', '一口', '影子', '得意', '玩乐', '我爱你', '爱你', '我表示理解', '我看过', '我不配', '慢慢', '关键词', '不该', '现在那边是几点', '喜欢', '小孩', '怎么办', '越来越好', '我爱', '不是故意', '画', '无用', '不值得', '太阳', '天下', '兄妹', '瘦子']);
const edgePunctuation = /^[\s《》〈〉「」『』“”‘’"'`【】\[\]（）()，,。.!！?？：:；;、~～·]+|[\s《》〈〉「」『』“”‘’"'`【】\[\]（）()，,。.!！?？：:；;、~～·]+$/gu;
const emojiEdges = /^[\p{Extended_Pictographic}\uFE0F\u200D\s]+|[\p{Extended_Pictographic}\uFE0F\u200D\s]+$/gu;
const chatWords = /^(?:哈+|呵+|嘿+|嘻+|[啊哦嗯唉哎诶]+|笑死(?:我了)?|上电视(?:了)?|合影(?:留念)?|打卡|来了|收到|谢谢(?:主播|梓宝|阿梓)?|晚安(?:梓宝|阿梓)?|好听(?:好听)*|太好听了|唱得好|牛+|[666]+|[233]+|点歌|唱歌|什么歌|下一首|随便|都行|不知道|忘了|没想好|好想你|唯一|主播|梓宝|阿梓|溣符雨)$/u;
const ordinaryChat = /直播间|上电视|合影|礼物|舰长|弹幕|下播|开播|录播|回放|点赞|点亮粉丝牌|点击|点进|点开|点外卖|点餐|点头|管理员|忽略.{0,8}规则|系统提示|api.?key|https?:\/\/|www\.|<script|\b(?:cs2|lol|valorant)\b/iu;
const negation = /不想(?:听|点|唱)|不愿(?:听|点|唱)|别(?:再)?(?:唱|听|点|来)|不要(?:再)?(?:唱|听|点|来)|不(?:要)?点(?:这|那)?首|不(?:喜欢|想要)|(?:别|不要|拒绝)\s*《/u;
const history = /刚(?:刚)?唱(?:过|了|完)|已经唱|唱过了|唱完了|(?:之前|昨天|上次|刚才).{0,12}唱|不是点歌|不是在点歌|这首歌.{0,8}(?:好听|难唱|叫什么)|唱得(?:好|不错)|原唱是|歌词是/u;
const artistNames = new Set(['杨丞琳', '黄龄', '田馥甄', '田姐', '孙燕姿', '胡歌', '周杰伦', '阿妹', '张惠妹', '王菲', '梁静茹', '陈绮贞', '李宗盛', '齐秦', '陶喆', '姚贝娜', '刘欢', '队长', '王心凌', '徐佳莹', '丁世光', 'beyond', 'iu']);
const genericRequest = /(?:的歌|的歌曲|新歌|完整版|编曲|缓解|收尾|加仓|大盘|要sc|唱过|男的|小声|高难|大调|琵琶曲)|^(?:rap|r&b|你了|你|阿梓|梓神|梓宝|宝宝|的|得|了|完|歌)/iu;
const subject = '(?:(?:阿梓|梓宝|梓神|宝宝|宝|主播)[，,：:\\s]*)?';
const requestPrefix = new RegExp(`^${subject}(?:(?:我|我们|大家)(?:还|好|真的|特别)?(?:很|好)?|还|真的)?(?:好?想听|想点|点歌|点(?:个|一首)?|求(?:唱(?:一首)?|一首)?|来(?:一|一小)?首|唱(?:一|一小)?首|唱一下|唱个|唱|听一首|听个|能不能(?:再)?唱|可以(?:再)?唱|会(?:再)?唱|能(?:再)?唱|来个)(?:一下|一首|一小首)?[：:\\s]*`, 'u');
const requestSuffix = /(?:来一首|安排一下|安排|求求了|求求|能唱吗|会唱吗|可以唱吗|可以点吗|能点吗|可以吗|唱一下|走起)[！!？?。\s]*$/u;
const politeSuffix = /(?:可以吗|行吗|好吗|好不好|怎么样|谢谢|求求了|求求|拜托了|拜托|啦|吧|呗|啊|呀|哦|捏|吗)[！!？?。\s]*$/u;

export function normalizeSongTitle(input) {
  if (typeof input !== 'string' || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(input)) return null;
  let title = input.normalize('NFKC').trim().replace(edgePunctuation, '').replace(/\s+/gu, ' ');
  title = title.replace(/(?<=\p{Script=Han})\s+(?=\p{Script=Han})/gu, '');
  if (!title || [...title].length > MAX_TITLE_LENGTH || (!/\p{L}/u.test(title) && !['11', '202', '525'].includes(title))
      || /[<>\{\}\r\n]|https?:\/\/|\p{Extended_Pictographic}/iu.test(title)) return null;
  return { key: title.toLocaleLowerCase('en-US'), title };
}

export function createSongCatalog(value = sourceCatalog) {
  if (value?.[CATALOG]) return value;
  const rows = Array.isArray(value) ? value : (value?.songs ?? value?.items ?? []);
  const entries = new Map();
  const aliases = new Map();
  for (const raw of rows) {
    const item = typeof raw === 'string' ? { title: raw } : raw;
    const normalized = normalizeSongTitle(item?.title ?? item?.name);
    if (!normalized) throw new TypeError('Invalid song catalog title');
    const entry = { ...normalized, requiresExplicit: Boolean(item.requiresExplicit) || ambiguousNames.has(normalized.title) };
    if (entries.has(entry.key)) throw new TypeError('Duplicate song catalog title');
    entries.set(entry.key, entry);
    for (const name of [entry.title, ...(item.aliases ?? [])]) {
      const alias = normalizeSongTitle(name);
      if (!alias) throw new TypeError('Invalid song catalog alias');
      if (aliases.has(alias.key) && aliases.get(alias.key).key !== entry.key) throw new TypeError('Ambiguous song catalog alias');
      aliases.set(alias.key, entry);
    }
  }
  return { [CATALOG]: true, entries, aliases };
}

export const DEFAULT_SONG_CATALOG = createSongCatalog();
export const SONG_CATALOG_META = Object.freeze({
  schemaVersion: sourceCatalog.schemaVersion,
  updatedAt: sourceCatalog.updatedAt,
  count: DEFAULT_SONG_CATALOG.entries.size,
  sources: sourceCatalog.sources,
  note: sourceCatalog.note,
});
export const allowedSongs = (catalog = DEFAULT_SONG_CATALOG) => [...createSongCatalog(catalog).entries.values()].map(item => item.title);

export function resolveSongTitle(input, catalog = DEFAULT_SONG_CATALOG) {
  const normalized = normalizeSongTitle(input);
  if (!normalized) return null;
  const known = createSongCatalog(catalog).aliases.get(normalized.key);
  return known ? { key: known.key, title: known.title } : normalized;
}

const empty = ignoredReason => ({ songs: [], ignoredReason });

function titleCandidate(input, catalog, explicit, reason, allowUnknown = explicit) {
  let value = input.trim().replace(/(?:\[[^\[\]]{1,12}\])+$/u, '').replace(emojiEdges, '').trim();
  const direct = normalizeSongTitle(value);
  const knownDirect = direct && catalog.aliases.get(direct.key);
  if (!knownDirect) value = value.replace(politeSuffix, '').trim();
  const normalized = normalizeSongTitle(value);
  if (!normalized) return null;
  const known = catalog.aliases.get(normalized.key);
  if (known) {
    if (known.requiresExplicit && !explicit) return null;
    return { key: known.key, title: known.title, confidence: 'catalog', explicit, reason };
  }
  if (!allowUnknown || !explicit || [...normalized.title].length < 2 || (chatWords.test(normalized.title) && !ambiguousNames.has(normalized.title))
      || artistNames.has(normalized.title) || genericRequest.test(normalized.title)
      || ordinaryChat.test(normalized.title) || /[？?\[\]]|(?:什么|怎么|为啥|因为|其实|刚才|已经|好听|难唱|歌词|原唱|弹幕|想听|点歌|唱|梓神|梓宝|阿梓|主播|你说话|你讲话|解释|看法|想法|笑声|评价|意见)|谢谢|^(?:我在|我也)|的$/u.test(normalized.title)) return null;
  // 陌生名称保留原词，不猜测歌名或借用已知歌名的子串。
  return { ...normalized, confidence: 'unknown', explicit: true, reason };
}

function parsePayload(payload, catalog, explicit, reason, allowUnknown = explicit) {
  const result = [];
  const add = candidate => { if (candidate && !result.some(item => item.key === candidate.key) && result.length < MAX_SONGS) result.push(candidate); };
  const direct = titleCandidate(payload, catalog, explicit, reason, allowUnknown);
  if (direct?.confidence === 'catalog') return [direct];
  const wrapped = [...payload.matchAll(/《([^《》]{1,80})》/gu)];
  if (wrapped.length) {
    const remaining = payload.replace(/《[^《》]{1,80}》/gu, '').replace(/(?:以及|或者|还有|和|或|再|吧|呀|啊|谢谢|求求了|求求|可以吗|好吗|拜托|[\s，,、＋+&！!？?。])/gu, '');
    if (remaining) return result;
    for (const match of wrapped) add(titleCandidate(match[1], catalog, true, 'book-title-request'));
    return result;
  }
  const parts = payload.split(/\s*(?:、|,|，|以及|或者|还有|和|或|＋|\+|\s+&\s+)\s*/u).filter(Boolean);
  if (parts.length > 1) {
    const candidates = parts.map(part => titleCandidate(part, catalog, explicit, reason, allowUnknown));
    const clearSeparator = /[、,，＋+]|\s+&\s+/u.test(payload);
    if (!clearSeparator && candidates.some(candidate => candidate?.confidence === 'unknown' || !candidate)) {
      // “风和日丽”中的“和”属于名称，不能凭连接词拆出不存在的歌。
      const known = candidates.filter(candidate => candidate?.confidence === 'catalog');
      if (known.length) for (const candidate of known) add(candidate);
      else if (direct) add(direct);
      return result;
    }
    for (const candidate of candidates) add(candidate);
    return result;
  }
  const spaced = payload.trim().split(/\s+/u);
  if (spaced.length > 1 && spaced.every(part => {
    const normalized = normalizeSongTitle(part);
    return normalized && catalog.aliases.has(normalized.key);
  })) {
    for (const part of spaced) add(titleCandidate(part, catalog, explicit, reason));
    return result;
  }
  const artist = payload.match(/^([\p{Script=Han}a-zA-Z·]{2,12})(?:的|\s+)(.+)$/u);
  if (artist && artistNames.has(artist[1].toLowerCase())) {
    const artistSong = titleCandidate(artist[2], catalog, explicit, 'artist-qualified-title');
    if (artistSong?.confidence === 'catalog') return [artistSong];
  }
  // 同一条弹幕反复写同一歌名只产生一个请求。
  const compact = normalizeSongTitle(payload);
  if (compact) {
    for (let length = 1; length <= compact.key.length / 2; length++) {
      if (compact.key.length % length !== 0) continue;
      const alias = compact.key.slice(0, length);
      const known = catalog.aliases.get(alias);
      if (known && alias.repeat(compact.key.length / length) === compact.key && (!known.requiresExplicit || explicit)) {
        return [{ key: known.key, title: known.title, confidence: 'catalog', explicit, reason: 'repeated-catalog-title' }];
      }
    }
  }
  if (direct) return [direct];
  return result;
}

export function classifySongRequests(text, catalog = DEFAULT_SONG_CATALOG) {
  if (typeof text !== 'string' || !text.trim()) return empty('empty');
  if ([...text].length > MAX_TEXT_LENGTH) return empty('too-long');
  const table = createSongCatalog(catalog);
  const content = text.normalize('NFKC').trim();
  const compact = content.replace(/(?<=\p{Script=Han})\s+(?=\p{Script=Han})/gu, '');
  const repeated = compact.match(/^(.{2,100})\1+$/us);
  if (repeated && !table.aliases.has(normalizeSongTitle(content)?.key)) return classifySongRequests(repeated[1], table);
  const songs = [];
  let rejectedReason = 'not-song-request';
  for (const raw of content.split(/[；;。\r\n]|[,，](?=\s*(?:别|不要|不想|想听|点歌|来首|唱|求))/u)) {
    const rawTitle = normalizeSongTitle(raw.trim().replace(emojiEdges, ''));
    const clause = rawTitle && table.aliases.has(rawTitle.key) ? raw.trim()
      : raw.trim().replace(/[，,\s]*(?:梓神|梓宝|阿梓|宝宝|宝|主播)[！!。\s]*$/u, '').trim();
    if (!clause) continue;
    const exact = normalizeSongTitle(clause.replace(emojiEdges, ''));
    const exactKnown = exact && table.aliases.get(exact.key);
    // 歌名本身可能以“别”或“不要”开头，完整目录匹配优先于聊天语义。
    if (exactKnown && !exactKnown.requiresExplicit && !/《/u.test(clause)) {
      if (!songs.some(item => item.key === exactKnown.key) && songs.length < MAX_SONGS) songs.push({
        key: exactKnown.key, title: exactKnown.title, confidence: 'catalog', explicit: false, reason: 'bare-catalog-title',
      });
      continue;
    }
    if (negation.test(clause) || /^(?:不要|别)(?!忘记)/u.test(clause) || /(?:别唱|不要唱|不唱|不想听|不点|不喜欢)[！!。\s]*$/u.test(clause)) { rejectedReason = 'negated'; continue; }
    if (history.test(clause)) { rejectedReason = 'history-or-song-chat'; continue; }
    if (ordinaryChat.test(clause)) { rejectedReason = 'ordinary-chat'; continue; }
    const prefix = clause.match(requestPrefix);
    const suffix = clause.match(requestSuffix);
    const explicit = Boolean(prefix || suffix);
    // 单独“唱”常出现在演唱评价中，未知名称要求更明确的点歌意图。
    const verb = prefix?.[0].trim().replace(new RegExp(`^${subject}`, 'u'), '').trim();
    const allowUnknown = explicit && verb !== '唱' && verb !== '来个';
    let payload = prefix ? clause.slice(prefix[0].length).trim() : clause;
    if (suffix) payload = payload.replace(requestSuffix, '').trim();
    if (!payload) continue;
    for (const candidate of parsePayload(payload, table, explicit, explicit ? 'explicit-request' : 'bare-catalog-title', allowUnknown)) {
      const existing = songs.find(item => item.key === candidate.key);
      if (existing) existing.explicit ||= candidate.explicit;
      else if (songs.length < MAX_SONGS) songs.push(candidate);
    }
  }
  return { songs, ignoredReason: songs.length ? null : rejectedReason };
}

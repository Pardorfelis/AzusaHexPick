import { readFileSync } from 'node:fs';

const catalog = JSON.parse(readFileSync(new URL('../data/equipment-aliases.json', import.meta.url), 'utf8'));
const names = catalog.items.map(item => item.name);
const nameSet = new Set(names);
const normalize = value => String(value ?? '').normalize('NFKC').toLowerCase().trim().slice(0, 2000);
const aliases = new Map(catalog.items.flatMap(item => [item.name, ...item.aliases].map(alias => [normalize(alias), item.name])));
const escaped = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const mentionPattern = [...aliases.keys()].sort((a, b) => b.length - a.length).map(escaped).join('|');
const ambiguousTerms = (catalog.ambiguousAliases ?? []).map(item => normalize(item.alias));
const ambiguousPattern = ambiguousTerms.map(escaped).join('|');
const categories = ['current', 'later', 'alternatives', 'against', 'conditional'];

export const allowedEquipment = () => [...names];

function findMentions(content) {
  const ambiguous = ambiguousPattern ? [...content.matchAll(new RegExp(ambiguousPattern, 'g'))] : [];
  return [...content.matchAll(new RegExp(mentionPattern, 'g'))]
    // 小绿甲等未知整词不能借用已知简称的子串投票。
    .filter(match => !ambiguous.some(term => match.index >= term.index && match.index + match[0].length <= term.index + term[0].length))
    .map(match => ({ name: aliases.get(match[0]), token: match[0], index: match.index,
      before: content.slice(0, match.index).split(/[，,。；;！!]/).at(-1),
      after: content.slice(match.index + match[0].length),
    }));
}

// 此列表仅检索文本实际出现的名称，不猜测陌生昵称所指装备。
export function equipmentCandidates(text, limit = 24) {
  const cap = Number.isFinite(limit) ? Math.max(0, Math.min(24, Math.floor(limit))) : 24;
  return [...new Set(findMentions(normalize(text)).map(item => item.name))].slice(0, cap);
}

const conditionPattern = /如果|要是|假如|有钱|有经济|没装备|(?:对面|要)[^，,。！？]{1,18}就/;
const mechanicsPattern = /附带|触发|特效|机制|加成|被动|伤害计算|[qwer技能].{0,3}带.{0,12}(?:效果|伤害)/;
const ordinaryPattern = /出门|出去|出发|出事|出口|出道|出差|出生|出成绩|做饭|做作业|做家务|补作业|补课|买房|买菜|买衣服|买手机|买电脑|买机票|买股票|管理员|忽略.{0,8}规则|command\s*=|<script|\{\s*["']?/;
const descriptivePattern = /(?:出装|装备)(?:都|其实|也|真|确实|基本|没啥|没有|没|没什么|挺|很|还|完全|主打|是|的|\s)*(?:问题|错|好|不错|合理|听劝)|出装主打听劝/;
const questionPattern = /[？?]|不香吗|不好吗|难道|为什么|为啥|为何|怎么|是否|要不要|该不该|能不能|吗[！!。\s]*$/;
const negativeCue = /别|不要|不用|不出|不买|不做|不推荐|不建议|不想|不愿|不打算|不必|没必要|没有必要|不值得|用不着|没(?:啥|什么)?用|不该|不能/;

export function extractUnknownEquipmentCandidates(text) {
  const content = normalize(text);
  if (!content || ordinaryPattern.test(content) || conditionPattern.test(content)) return [];
  const terms = [];
  const add = value => {
    let term = value;
    if (!term) return;
    if (!aliases.has(term) && /[吧呗啊呀哦啦]$/.test(term)) term = term.slice(0, -1);
    if (aliases.has(term) || equipmentCandidates(term).length || /^(?:法穿|魔抗|护甲|坦度|装备|出装|听劝|输出|伤害|肉装)$/.test(term)) return;
    if (!terms.includes(term) && terms.length < 3) terms.push(term);
  };
  for (const raw of content.split(/[，,。；;！!、＋+]/)) {
    const clause = raw.trim();
    if (descriptivePattern.test(clause) || questionPattern.test(clause) || negativeCue.test(clause)
        || /多少|不知道|不确定|无所谓|没钱/.test(clause) || mechanicsPattern.test(clause)
        || /刚才|之前|昨天|上把|已出|已经|出过|买过|以后|后面|最后一件/.test(clause)) continue;
    const purchase = clause.match(/^(?:现在|这把|先|直接|建议|推荐|优先)?(?:出|买|做|补|整)(?:一件|一个|个|件)?\s*([\p{Script=Han}a-z]{2,10})(?:吧|呗|啊|呀|哦|啦)?$/u);
    const bare = clause.match(/^([\p{Script=Han}a-z]{1,9}(?:剑|杖|弓|刀|甲|靴|鞋|盾|枪|弩|矛|铠|盔|拳|书|面具|斗篷|腰带|火炬|药水))(?:吧|呗|啊|呀)?$/u);
    // 换装只提取目标原词，已知来源物品不能遮掉陌生目标。
    const replacement = clause.match(/(?:换成|换|改成)(?:一件|一个|个|件)?\s*([\p{Script=Han}a-z]{2,10})(?:吧|呗|啊|呀|哦|啦)?$/u);
    add(replacement?.[1] ?? purchase?.[1] ?? bare?.[1] ?? (ambiguousTerms.includes(clause) ? clause : null));
    // 直接大穿等推荐片段可能嵌在较长对局上下文中。
    if (ambiguousPattern) {
      const cue = new RegExp(`(?:直接|优先|推荐|建议|先|出|买|做|补|整|换成|换)(?:一件|一个|个|件)?\\s*(${ambiguousPattern})`, 'g');
      const known = findMentions(clause);
      for (const match of clause.matchAll(cue)) {
        const start = match.index + match[0].lastIndexOf(match[1]);
        if (!known.some(item => item.index <= start && item.index + item.token.length >= start + match[1].length)) add(match[1]);
      }
    }
    if (terms.length >= 3) break;
  }
  return terms;
}

function empty(reason = 'not-suggestion') {
  return { current: [], later: [], alternatives: [], against: [], conditional: [],
    uncertain: false, pending: false, recognized: false, reason };
}

export function validateInterpretation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const schema = [...categories, 'uncertain'];
  if (schema.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !schema.includes(key))) return null;
  const result = empty('classified');
  for (const category of categories) {
    const items = value[category];
    if (!Array.isArray(items) || items.some(item => !nameSet.has(item))) return null;
    result[category] = [...new Set(items)];
  }
  if (result.current.length > 1 || typeof value.uncertain !== 'boolean') return null;
  result.uncertain = value.uncertain === true;
  // 歧义、条件和备选不强行转换成首选。
  if (result.uncertain && result.current.length) return null;
  if (result.current.some(item => result.against.includes(item))) return null;
  result.pending = result.uncertain;
  result.recognized = categories.some(category => result[category].length > 0);
  return result;
}

export function classifyEquipment(text, context = {}) {
  if (context.roundActive === false || (context.game && context.game !== '英雄联盟' && context.game !== 'LoL')) {
    return empty('inactive-context');
  }
  const content = normalize(text);
  if (!content || /^[\d\sDd]+$/.test(content) || /^[\d.]+\s*[wk万千]?$/i.test(content)
      || /^(?:哈|啊|哦|嗯|笑死|好耶|666|\[[^\]]+\])+[！!。\s]*$/.test(content)) return empty();
  if (/cs2|csgo|开箱|饰品.{0,8}(?:价格|贵|元)|好高的帽子|戴帽|帽子.{0,4}(?:颜色|高度)/.test(content)) return empty();
  const mentions = findMentions(content);
  const unknownTerms = extractUnknownEquipmentCandidates(content);
  const purchaseCue = new RegExp(`(?:出|买|做|补|推荐|建议|优先|先|直接|整|改|换成|换)(?:一件|个|件)?\\s*(?:${mentionPattern})`);
  if (descriptivePattern.test(content) && !purchaseCue.test(content)) return empty('descriptive-chat');
  if (!mentions.length) {
    const equipmentCue = unknownTerms.length > 0
      || /^(?:出|买|做|补)(?:法穿|魔抗|护甲|坦度|装备|肉装)$/.test(content);
    return equipmentCue ? { ...empty('unknown-expression'), uncertain: true, pending: true } : empty();
  }
  if (mechanicsPattern.test(content) && !purchaseCue.test(content) && !unknownTerms.length) return empty('mechanics-discussion');
  if (questionPattern.test(content)) {
    return { ...empty('question-or-ambiguity'), uncertain: true, pending: true };
  }
  if (/不知道|不确定|能加多少|也打不动|无所谓|不如不出|没钱|买不起|钱不够/.test(content)) {
    return { ...empty('uncertain-attitude'), uncertain: true, pending: true };
  }
  const result = empty('local-rules');
  const positive = [];
  const hasCondition = conditionPattern.test(content);
  for (const mention of mentions) {
    if (/(?:刚才|之前|原来|昨天|上把|已经|早就|已选|出了|买了|出过|买过)[^，,。]{0,8}$/.test(mention.before)
        || /^\s*(?:已经|上把|昨天|之前|刚才)/.test(mention.after)) continue;
    // 换装句中前一个装备是被替换对象，不能同时得到首选票。
    if (/^\s*(?:卖了?\s*)?(?:换成|换|改成)/.test(mention.after)) continue;
    const negative = /(?:先别|暂时别|别|不要|不用|不需要|不推荐|不建议|不考虑|不该|不能|不想|不愿|不打算|不必|没必要|没有必要|不值得|用不着)(?:再|急着|急)?(?:出|买|做|补|考虑|换成|换)?(?:一件|个|件)?\s*$/.test(mention.before)
      || /(?:不出|不买|不做)\s*$/.test(mention.before)
      || /^\s*(?:先别|别|不要|不该|不能|不用)(?:出|买|做)?/.test(mention.after)
      || /^\s*(?:不出|不买|不做|不补)/.test(mention.after)
      || /^\s*(?:也)?(?:没(?:啥|什么)?用|无用|没必要|不值得|没收益)/.test(mention.after);
    if (negative && hasCondition) return { ...empty('conditional-negative'), uncertain: true, pending: true };
    if (negative) result.against.push(mention.name);
    else positive.push(mention);
  }
  if (!positive.length && !result.against.length) return unknownTerms.length
    ? { ...empty('unknown-replacement'), uncertain: true, pending: true } : empty('retrospective-or-replacement');
  const hasAlternatives = /或者|或是|(?:都行|都可以|二选一|任选)/.test(content);
  const onlyNames = content.replace(new RegExp(mentionPattern, 'g'), '').replace(/[，,。；;！!\s啊呀吧呗哦啦]/g, '') === ''
    && new Set(positive.map(item => item.name)).size === 1;
  let unclassifiedMention = false;
  for (const mention of positive) {
    if (/(?:再|然后|之后|接着|后面|后续|以后|最后一件)(?:可以|能|要)?(?:出|买|做|补)?(?:一件|个|件)?\s*$/.test(mention.before)) {
      result.later.push(mention.name);
    } else if (hasCondition) result.conditional.push(mention.name);
    else if (hasAlternatives && new Set(positive.map(item => item.name)).size > 1) result.alternatives.push(mention.name);
    else {
      const direct = onlyNames
        || /(?:出|买|做|补|推荐|建议|优先|先|直接|整|改|改成|换成|换)(?:一件|个|件)?\s*$/.test(mention.before)
        || /^做完再/.test(mention.after);
      if (direct) result.current.push(mention.name);
      else unclassifiedMention = true;
    }
  }
  for (const category of categories) result[category] = [...new Set(result[category])];
  if (result.current.length > 1 || (unclassifiedMention && positive.length > 1)
      || unknownTerms.length > 0) {
    result.current = [];
    result.uncertain = true;
    result.pending = true;
  }
  result.recognized = categories.some(category => result[category].length > 0);
  if (!result.recognized) {
    result.uncertain = true;
    result.pending = true;
    result.reason = 'ambiguous-expression';
  }
  return result;
}

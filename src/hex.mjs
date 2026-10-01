export const HEX_COMMANDS = Object.freeze(['1', '2', '3', '1d', '2d', '3d', 'd', '12d', '13d', '23d']);

const result = (command = null, tier = null, reason = 'ordinary', candidate = null) => ({
  command, tier, pending: candidate !== null, reason, candidate,
});
const support = (command, tier) => result(command, tier, 'support');
const ambiguous = candidate => result(null, null, 'ambiguous', candidate);
const edgePunctuation = /^[,，。.!！、~～…]+|[,，。.!！、~～…]+$/g;
const endings = '(?:吧|啊|呀|哦|啦|嘛|呗)?';
const actionPattern = '(?:[123]d?|(?:12|13|23|21|31|32)d|d)';
const allRefreshTarget = '(?:d+|(?:全部都|全都|全部|全|都|三个都)(?:d+|刷新|重刷|刷))';
const direct = new RegExp('^(?:(?:直接|就|赶紧|快|无脑|果断|当然|优先)(?:选|拿|取)?|选|拿|取|选个|拿个|推荐|建议(?:选|拿)?|我选)(' + actionPattern + ')(?:号)?' + endings + '$');
const required = new RegExp('^(?:必须|必选|必拿|一定(?:要)?(?:选|拿)?|肯定(?:选|拿)?)(' + actionPattern + ')(?:号)?' + endings + '$');
const actionEnding = new RegExp('^(' + actionPattern + ')(?:啊|呀|吧|哦|啦|嘛|呗)$');
const allRefresh = /^(?:直接|就|赶紧|快|果断|建议|必须|一定要)?(?:全部都|全都|全部|全|都|三个都)(?:d+|刷新|重刷|刷)(?:一下)?(?:了)?(?:吧|啊|呀|哦|啦|嘛|呗)?$/;
const allRefreshNegative = new RegExp('^(?:请问)?(?:别|不要|不)(?:再)?' + allRefreshTarget + '(?:了)?(?:吧|啊|呀|哦|呢)?$|^' + allRefreshTarget + '(?:先|暂时)?(?:别|不要|不)(?:刷新|重刷|刷)?$');
const praise = /^([123])(?:是|就是|才是)?(?:很|真|太|最|特别)?(?:无敌|强|厉害|牛|爽|好|猛|稳)(?:的|了|啊|呀|吧|哦|啦)?$/;
const emphaticQuestion = new RegExp('^这(?:还)?不(?:选|拿)(' + actionPattern + ')(?:(?:吗|嘛)[?？!！]*|[?？]+)$');
const rhetoricalPraise = /^([123])不(?:是)?(?:无敌|强|厉害|牛|爽|好|猛|稳)(?:的)?(?:吗|嘛)[?？]+$/;
const explicitRefresh = /^(?:刷新|重刷|刷)([123]{1,2})(?:号)?(?:一下)?(?:吧|啊|呀|哦|啦)?$|^([123]{1,2})(?:号)?(?:(?:刷新|重刷)(?:一下)?|刷一下)(?:吧|啊|呀|哦|啦)?$/;
const simpleNegative = new RegExp('^(?:请问)?(?:别|不要|不)(?:再)?(?:选|拿|取|要)?(' + actionPattern + ')(?:了|吧|啊|呀|哦|呢)?$');
const negativeQuality = new RegExp('^(' + actionPattern + ')(?:现在|目前|这轮)?(?:不行|没用|不要|别选|别拿|不值得(?:选|拿)?|太弱|垃圾)(?:了|吧|啊|呀|哦|呢|的)?$');
const negativeAssertion = new RegExp('^(' + actionPattern + ')(?:现在|目前|这轮)?(?:并不|不是|不)(?:很|太|特别|最)?(?:无敌|强|厉害|牛|爽|好|猛|稳|好用)(?:的|了|啊|呀|吧|哦|啦)?$');
const retrospective = new RegExp('刚才|刚刚|之前|上一(?:轮|把|次)|上把|上次|已经|已(?:选|拿)|早就|本来(?:就)?(?:该|应该)|选错|拿错|后悔|当时|昨天|(?:选|拿)' + actionPattern + '了|^' + actionPattern + '了$');
const future = /下(?:次|一?轮|一?把)|以后|后面再|等会|等下/;
const measurement = /\d(?:[.,]\d+)?(?:w|k|万|亿|千|百|块|元|金币|人民币|美元|欧元|秒|分钟|小时|天|年|月|日|点|分|伤害|血量|滴血|血|攻击|法强|人|个|只|位|手|层|级|杀|死|助攻|局|把|倍|楼|名|次|步|张|件|米|厘米|%)/;
const identifiers = /[123]号(?:门|选手|房|线|机|账号|用户)|(?:今天|明天|后天|昨天|前天).*\d号|[123]d(?:电影|动画|模型|打印|建模|显示|画面|图形|效果|空间|技术)|[123](?:是|这个)?(?:数字|数值|号码)/;
const instructions = /[{}<>]|(?:command|uncertain|tier|pending)[:=]|忽略.*(?:规则|指令)|(?:输出|返回)[123]/;
const negativeIntent = /(?:别|不要)(?:再)?(?:喊|刷|刷新|重刷|拿|选)|不推荐|不是选|没人让.*选|才怪|千万别|谁说.*好用|不(?:要|用).*(?:算|计).*票|[123]d?(?:先|暂时)?别|[123].*(?:垃|半废|拉胯|不是无敌的$)/;
const conditional = /如果|要是|假如|的话|看情况|可以考虑|或许|可能|不一定|^要(?!选|拿|取|刷)[^123]+(?:选|拿|取|刷)[123]|^没.*就(?:选|拿|取|刷)[123]/;

function canonicalAction(value) {
  if (HEX_COMMANDS.includes(value)) return value;
  const pair = value.match(/^([123])([123])d$/);
  return pair && pair[1] !== pair[2] ? [pair[1], pair[2]].sort().join('') + 'd' : null;
}

// 只移除空白与受限的边缘标点，不拼接中间标点两侧的数字。
export function classifyHex(text) {
  if (typeof text !== 'string' || text.length > 2000) return result();
  const normalized = text.normalize('NFKC').toLowerCase().replace(/\s+/gu, '').replace(edgePunctuation, '');
  const exact = canonicalAction(normalized);
  if (exact) return support(exact, 'exact');
  if (/^([123])\1+$/.test(normalized)) return support(normalized[0], 'repeated');
  if (/^d{2,}$/.test(normalized)) return support('d', 'repeated');
  if (!normalized || /\d[./-]\d|\d[+*=]\d|\d+(?:比|对|:)\d+/.test(normalized) || measurement.test(normalized)
      || identifiers.test(normalized) || instructions.test(normalized)) return result();
  if (allRefreshNegative.test(normalized)) return result(null, null, 'against');
  if (allRefresh.test(normalized)) return support('d', 'phrase');
  const completeActionPhrase = normalized.match(direct) || normalized.match(required) || normalized.match(actionEnding);
  if (completeActionPhrase && completeActionPhrase[1].endsWith('d'))
    return support(canonicalAction(completeActionPhrase[1]), 'phrase');
  const refresh = normalized.match(explicitRefresh);
  if (refresh) {
    const command = canonicalAction((refresh[1] ?? refresh[2]) + 'd');
    return command ? support(command, 'phrase') : result(null, null, 'multi');
  }
  if (retrospective.test(normalized)) return result(null, null, 'retrospective');
  if (future.test(normalized)) return result(null, null, 'future');
  if (!/\d/.test(normalized) && (simpleNegative.test(normalized) || negativeQuality.test(normalized) || negativeAssertion.test(normalized)))
    return result(null, null, 'against');

  const tokens = [...normalized.matchAll(/\d+d?/g)].map(match => match[0]);
  if (!tokens.length) return result();
  // 日期、金额与其他数字不能成为选项；混合选项数字不能选其中最多的一个。
  if (tokens.some(token => !/^[123]+d?$/.test(token))) return result();
  const tokenActions = tokens.map(token => /^([123])\1*$/.test(token) ? token[0] : canonicalAction(token));
  if (tokenActions.some(command => command === null)) return result(null, null, 'multi');
  const commands = [...new Set(tokenActions)];
  if (commands.length !== 1 || /d[123]|\ddd/.test(normalized)
      || /(?:^|[^0-9a-z])d+(?:$|[^a-z])/.test(normalized)
      || /(?:全部都|全都|全部|全|都|三个都)(?:d+|刷新|重刷|刷)/.test(normalized))
    return result(null, null, 'multi');
  const candidate = commands[0];

  if (/[a-ce-z]\d|\d[a-ce-z]|\dd[a-z]/.test(normalized)) return result();

  const rhetorical = normalized.match(emphaticQuestion) || normalized.match(rhetoricalPraise);
  if (rhetorical) return support(canonicalAction(rhetorical[1]), 'phrase');
  if (simpleNegative.test(normalized) || negativeQuality.test(normalized) || negativeAssertion.test(normalized) || negativeIntent.test(normalized))
    return result(null, null, 'against');
  if (conditional.test(normalized)) return result(null, null, 'conditional');
  if (/[?？]|(?:吗|么|能用不)$|^(?:为什么|怎么(?:选|拿))/.test(normalized)) return result(null, null, 'question');
  const phrase = normalized.match(direct) || normalized.match(required) || normalized.match(praise)
    || normalized.match(actionEnding);
  if (phrase) return support(canonicalAction(phrase[1]), 'phrase');
  if (/刷|骰子/.test(normalized)) return result(null, null, 'unsupported-refresh');
  if (/被削|削(?:过|了)|削弱|触发|机制|几率|概率|冷却|cd/.test(normalized)) return result();
  // 未认识的名词与复杂语用仅保留已有的唯一指令，供可选 AI 确认。
  return ambiguous(candidate);
}

export function validateHexInterpretation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 2 || !keys.includes('command') || !keys.includes('uncertain')) return null;
  if (HEX_COMMANDS.includes(value.command) && value.uncertain === false)
    return { command: value.command, uncertain: false };
  if (value.command === null && value.uncertain === true) return { command: null, uncertain: true };
  return null;
}

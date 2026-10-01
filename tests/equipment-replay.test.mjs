import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {classifyEquipment} from '../src/equipment.mjs';
import {extractUnknownEquipmentCandidates} from '../src/equipment.mjs';
import {PanelEngine} from '../src/engine.mjs';

const BLADE = '破败王者之刃';

test('锁定与重复锁定不刷新最后一次建议时间', () => {
  let now = 0;
  const engine = new PanelEngine({now: () => now});
  engine.setConnection('connected', 'sample');
  engine.startRound({seconds: 10});
  now = 1000;
  engine.ingest({id:'one', text:'2', anonymousId:'anonymous', at:now, source:'sample'});
  now = 2000;
  assert.equal(engine.lockRound().latestUpdateAt, 1000);
  now = 4000;
  assert.equal(engine.lockRound('replay-paused').latestUpdateAt, 1000);
  assert.equal(engine.snapshot().lockReason, 'manual');
  assert.equal(engine.snapshot().hex[1].votes, 1);
});

test('真实 P3 的伤害疑问及消极表达不误计为支持', () => {
  const data = JSON.parse(readFileSync(new URL('../data/replays/azusa-p3.json', import.meta.url), 'utf8'));
  for (const text of ['对面这种万雪的出破败能加多少伤害不知道', '出破败也打不动无所谓的']) {
    assert.ok(data.messages.some(row => row.text === text));
    const result = classifyEquipment(text);
    assert.deepEqual(result.current, []);
    assert.equal(result.pending, true);
  }
});

test('常用简称归并正式名，歧义昵称仍不猜测', () => {
  for (const [text, name] of [['焚天', '焚天'], ['冰拳', '冰脉护手'], ['海妖', '海妖杀手'],
    ['狂徒', '狂徒铠甲'], ['黑切', '黑色切割者'], ['峡谷制造者', '裂隙制造者'], ['杀人书', '梅贾的窃魂卷']]) {
    assert.deepEqual(classifyEquipment(text).current, [name]);
    assert.equal(classifyEquipment(text).pending, false);
  }
  assert.equal(classifyEquipment('兰德里').pending, true);
  assert.deepEqual(classifyEquipment('兰德里').current, []);
  assert.equal(classifyEquipment('今天真好').pending, false);
});

test('真实 P3 的明确反对、明确购买和机制讨论分别处理', () => {
  assert.deepEqual(classifyEquipment('破败没用').against, [BLADE]);
  assert.deepEqual(classifyEquipment('出破败啊 不然你谁都打不过').current, [BLADE]);
  for (const text of ['q带破败效果', 'q带破败伤害', 'q能附带破败特效啊']) {
    assert.deepEqual(classifyEquipment(text).current, []);
    assert.equal(classifyEquipment(text).pending, false);
  }
  const changed = classifyEquipment('破败没用，出金身');
  assert.deepEqual(changed.against, [BLADE]);
  assert.deepEqual(changed.current, ['中娅沙漏']);
});

test('新增真实现场样例区分描述、换装与复杂组合', () => {
  for (const text of ['其实都差不多，出装没啥问题', '出装没啥问题', '装备没问题', '出装挺好', '出装主打听劝']) {
    const result = classifyEquipment(text);
    assert.deepEqual(result.current, []);
    assert.equal(result.pending, false, text);
  }
  for (const text of ['鞋子换无尽', '圆弧换无尽', '整个无尽呗']) {
    assert.deepEqual(classifyEquipment(text).current, ['无尽之刃'], text);
  }
  for (const text of ['破败打塔姆好点', '梦魇伤害靠平a，直接大穿＋无尽，打起来先等塔姆上了你再飞后排']) {
    assert.deepEqual(classifyEquipment(text).current, [], text);
    assert.equal(classifyEquipment(text).pending, true, text);
  }
  assert.deepEqual(classifyEquipment('最后一件可以破败').later, [BLADE]);
  assert.deepEqual(classifyEquipment('最后一件可以破败').current, []);
});

test('真实长句保留未知大穿，实际引擎不投无尽并展示重复原词', () => {
  const text = '梦魇伤害靠平a，直接大穿+无尽，打起来先等塔姆上了你再飞后排';
  let now = 0;
  const engine = new PanelEngine({now: () => now});
  engine.setConnection('connected', 'review');
  engine.startRound({mode: 'equipment', counting: 'messages', seconds: 60});
  for (let i = 0; i < 3; i++) {
    now += 100;
    const result = engine.ingest({id: `history-${i}`, text, anonymousId: `viewer-${i}`, at: now, source: 'review'});
    assert.equal(result.pending, true);
  }
  assert.deepEqual(extractUnknownEquipmentCandidates(text), ['大穿']);
  assert.deepEqual(engine.snapshot().equipment.top3, []);
  assert.deepEqual(engine.snapshot().equipment.unknown, [{term: '大穿', messageMentions: 3, anonymousMentions: 3, mentions: 3}]);
});

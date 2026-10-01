import test from 'node:test';
import assert from 'node:assert/strict';
import { PanelEngine } from '../src/engine.mjs';

test('全部刷新与组合刷新各一条动作，不拆成单项票', () => {
  const engine = new PanelEngine({now:() => 0});
  engine.setConnection('connected', 'source');
  engine.startRound({mode:'hex', seconds:30});
  const texts = ['D', 'dddddd', '全d了', '全刷了', '12d', '21d', '23d', '13d'];
  texts.forEach((text,index) => engine.ingest({id:String(index), text, source:'source'}));
  const counts = Object.fromEntries(engine.snapshot().hex.map(row => [row.key,row.votes]));
  assert.deepEqual(counts, {'1':0, '2':0, '3':0, '1d':0, '2d':0, '3d':0, d:4, '12d':2, '13d':1, '23d':1});
  assert.equal(engine.snapshot().validMessages, texts.length);
  assert.equal(engine.snapshot().hex.reduce((sum,row) => sum + row.votes,0), texts.length);
  assert.equal(engine.snapshot().hex.find(row => row.key === 'd').label, '全部刷新');
});

test('匿名修改完整刷新动作，反对撤回而消息历史保留', () => {
  const engine = new PanelEngine({now:() => 0});
  engine.setConnection('connected', 'source');
  engine.startRound({mode:'hex', counting:'anonymous', seconds:30});
  for (const [id,text] of [['a','d'],['b','12d'],['c','不要全d']])
    engine.ingest({id,text,anonymousId:'same',source:'source'});
  assert.equal(engine.snapshot().hex.reduce((sum,row) => sum + row.votes,0), 0);
  assert.equal(engine.snapshot().validMessages, 2);
  assert.equal(engine.snapshot().hex.find(row => row.key === 'd').messageVotes, 1);
  assert.equal(engine.snapshot().hex.find(row => row.key === '12d').messageVotes, 1);
});

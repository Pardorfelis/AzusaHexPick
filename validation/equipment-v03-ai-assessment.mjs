import assert from 'node:assert/strict';
import {readFile, writeFile} from 'node:fs/promises';
import {PanelEngine} from '../src/engine.mjs';
import {AiService} from '../src/ai-service.mjs';
import {extractUnknownEquipmentCandidates} from '../src/equipment.mjs';

const initial = JSON.parse(await readFile(new URL('./equipment-v03-ai-initial-result.json', import.meta.url),'utf8'));
const text = initial.cases[1].text;
const engine = new PanelEngine({now:() => 10000});
engine.setConnection('connected','historical-offline');
engine.startRound({mode:'equipment',seconds:30});
let calls = 0;
const ai = new AiService({engine,key:'offline-fixture',fetcher:async () => {
  calls += 1;
  throw new Error('离线复核不得请求模型。');
}});
ai.configure({enabled:true});
for (let index=0;index<3;index+=1) {
  engine.ingest({id:'offline:' + index, anonymousId:'offline:' + index, text,source:'historical-offline'});
  await ai.tick();
}
const state = engine.snapshot();
assert.deepEqual(extractUnknownEquipmentCandidates(text),['大穿']);
assert.equal(calls,0);
assert.equal(ai.snapshot().roundRequests,0);
assert.equal(state.validMessages,0);
assert.deepEqual(state.equipment.top3,[]);
assert.equal(state.equipment.unknown[0].term,'大穿');
assert.equal(state.equipment.unknown[0].mentions,3);
ai.stop();
const result = {version:'0.3.0',checkedAt:new Date().toISOString(),
  scope:'首次真实模型响应的人工语义复核，以及同一长句修复后离线保护；不是再次付费验证模型。',
  initialApiResult:'equipment-v03-ai-initial-result.json',
  initialApiCalls:initial.apiCalls, initialElapsedMs:initial.elapsedMs,
  initialEstimatedPeakCostCny:initial.estimatedPeakCostCny,
  initialSemanticReview:[
    {text:initial.cases[0].text,outcome:'购买意图与破败标准名符合该句。'},
    {text,outcome:'只将无尽记为首选，遗漏大穿备选，不能认定该句理解正确。'},
  ],
  repairedGuard:{unknownTerms:['大穿'],messages:3,modelRequests:0,validMessages:0,
    currentRecommendations:[],unknownMentions:3,allAssertionsPassed:true},
  furtherPaidApiCalls:0,additionalLiveConnections:0,
};
await writeFile(new URL('./equipment-v03-ai-assessment-result.json',import.meta.url),JSON.stringify(result,null,2),'utf8');
console.log(JSON.stringify(result));

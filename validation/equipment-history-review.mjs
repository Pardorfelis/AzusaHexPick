import {readFile, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {classifyEquipment, equipmentCandidates, extractUnknownEquipmentCandidates} from '../src/equipment.mjs';

const saved = JSON.parse(await readFile(new URL('./live-equipment-observation-result.json', import.meta.url), 'utf8'));
const rows = saved.samples.filter(row => row.type === 'equipment').map(row => ({
  text:row.text, observations:row.observations,
  historical:{current:row.equipment.current, pending:row.equipment.pending, reason:row.equipment.reason},
  current:classifyEquipment(row.text), candidates:equipmentCandidates(row.text),
  unknownTerms:extractUnknownEquipmentCandidates(row.text),
}));
const weighted = predicate => rows.reduce((sum,row) => sum + (predicate(row) ? row.observations : 0),0);
const result = {
  version:'0.3.0', checkedAt:new Date().toISOString(),
  scope:'只重判已保存的相关历史原文，不重建原始 420 条流，不合并为一轮，不代表用户此前收到 37 条的场景。',
  historySha256:createHash('sha256').update(await readFile(new URL('./live-equipment-observation-result.json', import.meta.url))).digest('hex'),
  weightedMessages:weighted(() => true),
  previousCurrentMessages:weighted(row => row.historical.current.length > 0),
  previousPendingMessages:weighted(row => row.historical.pending),
  currentCurrentMessages:weighted(row => row.current.current.length > 0),
  currentPendingMessages:weighted(row => row.current.pending),
  currentIgnoredMessages:weighted(row => !row.current.pending && !row.current.current.length
    && !row.current.against.length && !row.current.later.length && !row.current.alternatives.length && !row.current.conditional.length),
  paidApiCalls:0, additionalLiveConnections:0, rows,
};
await writeFile(new URL('./equipment-history-review-result.json', import.meta.url),JSON.stringify(result,null,2),'utf8');
console.log(JSON.stringify({...result,rows:undefined}));

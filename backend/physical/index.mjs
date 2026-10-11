import { memoryResult } from '../../contracts/index.mjs';

export function findObject(store, object) {
  const evidence = store.list('camera')
    .filter(item => item.object.toLowerCase() === object.trim().toLowerCase())
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
    .slice(0, 1);
  return memoryResult(evidence);
}

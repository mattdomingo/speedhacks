import { memoryResult } from '../../contracts/index.mjs';

export function normalizeObject(object) {
  const name = object.trim().toLowerCase().replace(/^my\s+/, '').replace(/[?.!]+$/, '').trim();
  if (['key', 'keys', 'keyring', 'key ring', 'set of keys'].includes(name)) return 'keys';
  if (['phone', 'cellphone', 'cell phone', 'mobile', 'mobile phone', 'iphone'].includes(name)) return 'phone';
  return name;
}

export async function findObject(store, object, { includeDemo = false, cameraStatus } = {}) {
  const matches = (await store.list('camera'))
    .filter(item => normalizeObject(item.object) === normalizeObject(object));
  const live = matches.filter(item => !item.demo);
  const evidence = (live.length || !includeDemo ? live : matches)
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
    .slice(0, 1);
  return { ...memoryResult(evidence), ...(cameraStatus ? { camera: await cameraStatus() } : {}) };
}

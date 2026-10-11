import { memoryResult } from '../../contracts/index.mjs';

// Engineer 2: replace these store reads with Google retrieval; preserve provenance.
export function getSchedule(store, date) {
  return memoryResult(store.list('calendar').filter(item => item.date === date));
}

export function searchMessages(store, query) {
  const words = query.toLowerCase().split(/\s+/);
  return memoryResult(store.list('email').filter(item =>
    words.every(word => item.text.toLowerCase().includes(word))).slice(0, 5));
}

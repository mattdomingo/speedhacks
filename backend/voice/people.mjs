import { memoryResult } from '../../contracts/index.mjs';

const STOPWORDS = new Set('a an and is my the who whos who\'s what about tell me again of to was her his their'.split(' '));

function words(text) {
  return String(text ?? '').toLowerCase().replace(/['’]s\b/g, '').match(/[\p{L}\p{N}]+/gu) ?? [];
}

const newestFirst = (a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp);

// who_is: the caller's own people and notes that name the person or relationship ("Sam", "my daughter").
// The store passed in is already scoped to the caller, so another patient's family never matches.
export async function whoIs(store, name, { includeDemo = false } = {}) {
  const terms = words(name).filter(word => word.length > 1 && !STOPWORDS.has(word));
  if (!terms.length) return memoryResult([]);
  const matches = record => {
    if (record.demo && !includeDemo) return false;
    const haystack = words(`${record.name ?? ''} ${record.relation ?? ''} ${record.text ?? ''}`);
    return terms.some(term => haystack.includes(term));
  };
  const people = (await store.list('person')).filter(matches).sort(newestFirst);
  const notes = (await store.list('note')).filter(matches).sort(newestFirst);
  return memoryResult([...people, ...notes].slice(0, 5));
}

// care_instructions: only what the caregiver saved, repeated as-is. Steph never adds medical advice.
export async function careInstructions(store, topic, { includeDemo = false } = {}) {
  const terms = words(topic).filter(word => word.length > 2 && !STOPWORDS.has(word));
  const saved = (await store.list('caregiver')).filter(record => includeDemo || !record.demo).sort(newestFirst);
  const relevant = terms.length
    ? saved.filter(record => terms.some(term => words(`${record.topic ?? ''} ${record.text}`).some(word => word.startsWith(term.slice(0, 4)))))
    : saved;
  return memoryResult(relevant.slice(0, 5));
}

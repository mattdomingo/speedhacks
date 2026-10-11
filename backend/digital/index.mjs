import { memoryResult } from '../../contracts/index.mjs';

// Words that carry no search signal in spoken questions ("did Sarah email me about dinner").
const STOPWORDS = new Set(('a an and any about are at be by did do does email emails for from has have i in is it ' +
  'me message messages my of on or say said send sent the to was what when where who with wrote you').split(' '));

function terms(query) {
  return [...new Set(query.toLowerCase().replace(/['’]s\b/g, '').match(/[\p{L}\p{N}]+/gu) ?? [])]
    .filter(word => word.length > 1 && !STOPWORDS.has(word));
}

function overlaps(item, date) {
  return item.date <= date && date <= (item.endDate ?? item.date);
}

function unavailable(source) {
  const error = new Error(`${source} is unavailable right now`);
  error.expose = true;
  return error;
}

// Engineer 2: Google records are synced into the store; uncovered dates are fetched live.
export async function getSchedule(store, date, google) {
  if (google?.can('calendar') && !google.covers(date)) {
    try {
      await google.fetchDay(date);
    } catch (error) {
      console.error(`Live calendar lookup failed: ${error.message}`);
      // An empty answer would wrongly claim "no plans"; report the failure instead.
      if (!store.list('calendar').some(item => overlaps(item, date))) throw unavailable('Calendar');
    }
  }
  return memoryResult(store.list('calendar')
    .filter(item => overlaps(item, date))
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp)));
}

function rank(store, words) {
  return store.list('email')
    .map(item => {
      const haystack = `${item.text} ${item.subject ?? ''} ${item.from ?? ''}`.toLowerCase();
      return { item, score: words.filter(word => haystack.includes(word)).length };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || Date.parse(b.item.timestamp) - Date.parse(a.item.timestamp))
    .slice(0, 5)
    .map(({ item }) => item);
}

export async function searchMessages(store, query, google) {
  const words = terms(query);
  if (!words.length) return memoryResult([]);
  const local = rank(store, words);
  if (local.length || !google?.can('gmail')) return memoryResult(local);
  try {
    // Gmail matches full bodies, which the stored snippet may not contain; trust its ranking.
    return memoryResult(await google.searchMail(words.join(' ')));
  } catch (error) {
    console.error(`Live Gmail search failed: ${error.message}`);
    throw unavailable('Email');
  }
}

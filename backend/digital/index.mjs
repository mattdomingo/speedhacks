import { memoryResult } from '../../contracts/index.mjs';
import { background } from '../background.mjs';

// Words that carry no search signal in spoken questions ("did Sarah email me about dinner").
const STOPWORDS = new Set(('a an and any about are at be by did do does email emails for from has have i in is it ' +
  'me message messages my of on or say said send sent the to was what when where who with wrote you').split(' '));

function words(text) {
  return text.toLowerCase().replace(/['’]s\b/g, '').match(/[\p{L}\p{N}]+/gu) ?? [];
}

function terms(query) {
  return [...new Set(words(query))].filter(word => word.length > 1 && !STOPWORDS.has(word));
}

// Whole words, with prefixes allowed for longer terms ("visit" finds "visiting").
function matches(term, haystack) {
  return haystack.some(word => word === term || (term.length >= 4 && word.startsWith(term)));
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
  const calendar = google ? await google.state('calendar') : 'absent';
  // An expired connection with nothing stored for the date cannot answer "no plans".
  if (calendar === 'reconnect_required' && !(await store.list('calendar')).some(item => overlaps(item, date))) {
    throw unavailable('Calendar');
  }
  if (calendar === 'connected') {
    background(google.refreshIfStale(background), 'Google refresh');
    if (!(await google.covers(date))) {
      try {
        await google.fetchDay(date);
      } catch (error) {
        console.error(`Live calendar lookup failed: ${error.message}`);
        // An empty answer would wrongly claim "no plans"; report the failure instead.
        if (!(await store.list('calendar')).some(item => overlaps(item, date))) throw unavailable('Calendar');
      }
    }
  }
  return memoryResult((await store.list('calendar'))
    .filter(item => overlaps(item, date))
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp)));
}

// Scores sender, subject and snippet only (not generated boilerplate such as dates), and
// needs at least half the terms so one common word cannot claim a match.
async function rank(store, query) {
  const needed = Math.ceil(query.length / 2);
  return (await store.list('email'))
    .map(item => {
      const haystack = words(item.snippet === undefined ? item.text
        : `${item.from ?? ''} ${item.fromAddress ?? ''} ${item.subject ?? ''} ${item.snippet}`);
      return { item, score: query.filter(term => matches(term, haystack)).length };
    })
    .filter(({ score }) => score >= needed)
    .sort((a, b) => b.score - a.score || Date.parse(b.item.timestamp) - Date.parse(a.item.timestamp))
    .slice(0, 5)
    .map(({ item }) => item);
}

export async function searchMessages(store, text, google) {
  const query = terms(text);
  if (!query.length) return memoryResult([]);
  const local = await rank(store, query);
  const gmail = google ? await google.state('gmail') : 'absent';
  if (gmail === 'reconnect_required' && !local.length) throw unavailable('Email');
  if (gmail !== 'connected') return memoryResult(local);
  background(google.refreshIfStale(background), 'Google refresh');
  if (local.length) return memoryResult(local);
  try {
    // Gmail matches full bodies, which the stored snippet may not contain; trust its ranking.
    return memoryResult(await google.searchMail(query.join(' ')));
  } catch (error) {
    console.error(`Live Gmail search failed: ${error.message}`);
    throw unavailable('Email');
  }
}

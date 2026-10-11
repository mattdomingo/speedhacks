import { memoryResult } from '../../contracts/index.mjs';
import { addDays, localDate, startOfDay } from '../time.mjs';

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

async function result(evidence, google, context) {
  if (google) await google.assertCurrent(context);
  return memoryResult(evidence);
}

async function records(store, source, includeDemo) {
  return (await store.list(source)).filter(item => includeDemo || !item.demo);
}

// Engineer 2: Google records are synced into the store; uncovered dates are fetched live.
export async function getSchedule(store, date, google, { includeDemo = false, endDate = date, failOnLiveError = false } = {}) {
  const context = google ? await google.snapshot('calendar') : undefined;
  const calendar = context?.state ?? 'absent';
  // A historical range can extend outside the synced window; fetch it in one bounded request.
  if (endDate !== date && calendar !== 'absent') {
    if (calendar !== 'connected') throw unavailable('Calendar');
    let live;
    try { live = await google.fetchRange(date, endDate, context); }
    catch {
      await google.assertCurrent(context);
      throw unavailable('Calendar');
    }
    const local = (await records(store, 'calendar', includeDemo)).filter(item => item.origin !== 'google-calendar');
    return result([...live, ...local].filter(item => item.date <= endDate && (item.endDate ?? item.date) >= date)
      .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp)), google, context);
  }
  // An expired connection with nothing stored for the date cannot answer "no plans".
  if (calendar === 'reconnect_required' && !(await records(store, 'calendar', includeDemo)).some(item => overlaps(item, date))) {
    throw unavailable('Calendar');
  }
  if (calendar === 'connected') {
    if (!(await google.covers(date))) {
      try {
        await google.fetchDay(date, context);
      } catch (error) {
        await google.assertCurrent(context);
        if (failOnLiveError) throw unavailable('Calendar');
        console.error(`Live calendar lookup failed: ${error.message}`);
        // An empty answer would wrongly claim "no plans"; report the failure instead.
        if (!(await records(store, 'calendar', includeDemo)).some(item => overlaps(item, date))) throw unavailable('Calendar');
      }
    }
  }
  return result((await records(store, 'calendar', includeDemo))
    .filter(item => item.date <= endDate && (item.endDate ?? item.date) >= date && (calendar !== 'absent' || item.origin !== 'google-calendar'))
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp)), google, context);
}

// Scores sender, subject and snippet only (not generated boilerplate such as dates), and
// needs at least half the terms so one common word cannot claim a match.
async function rank(store, query, includeGoogle, includeDemo, inPeriod) {
  const needed = Math.ceil(query.length / 2);
  return (await records(store, 'email', includeDemo))
    .filter(item => includeGoogle || item.origin !== 'google-gmail')
    .filter(inPeriod)
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

export async function searchMessages(store, text, google, { includeDemo = false, date, endDate = date, timeZone = 'UTC', failOnLiveError = false } = {}) {
  // Accept older clients' generic queries as well as the optional-query contract.
  const recent = text === undefined || /^(?:(?:recent|latest|new)\s+)?(?:e-?mails?|messages?|inbox)$/i.test(text.trim());
  const query = recent ? [] : terms(text);
  if (!recent && !query.length) return memoryResult([]);
  const context = google ? await google.snapshot('gmail') : undefined;
  const gmail = context?.state ?? 'absent';
  const inPeriod = item => !date || (localDate(item.timestamp, timeZone) >= date && localDate(item.timestamp, timeZone) <= endDate);
  const local = await rank(store, query, gmail !== 'absent', includeDemo, inPeriod);
  const liveRequired = recent || Boolean(date);
  if (gmail === 'reconnect_required' && (liveRequired || !local.length)) throw unavailable('Email');
  if (gmail !== 'connected') return result(local, google, context);
  // A fresh copy answers directly; a stale one (or a miss) asks Gmail within this request.
  if (!liveRequired && local.length && await google.mailFresh()) return result(local, google, context);
  try {
    // Gmail matches full bodies, which the stored snippet may not contain; trust its ranking.
    // Epoch bounds avoid Gmail's default time zone; include the exact start-of-day second.
    const periodQuery = date ? `after:${startOfDay(date, timeZone).getTime() / 1000 - 1} before:${startOfDay(addDays(endDate, 1), timeZone).getTime() / 1000}` : '';
    const live = (await google.searchMail([query.join(' '), periodQuery].filter(Boolean).join(' '), context)).filter(inPeriod);
    // A recent-mail request checks now; deleted messages must not reappear from the cache.
    if (liveRequired) return result(live.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp)).slice(0, 5), google, context);
    return result(live.length ? live : local, google, context);
  } catch (error) {
    await google.assertCurrent(context);
    if (failOnLiveError) throw unavailable('Email');
    console.error(`Live Gmail search failed: ${error.message}`);
    if (!liveRequired && local.length) return result(local, google, context);
    throw unavailable('Email');
  }
}

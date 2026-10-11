// npm run eval:golden — scores Steph's live /ask answers against the golden set the iPhone tests use,
// with whichever provider the backend runs (STEPH_PROVIDER: Claude or Gemini). It spends real tokens,
// so it runs only when ANTHROPIC_API_KEY or GEMINI_API_KEY is set, against a running backend:
// BACKEND_URL (default http://127.0.0.1:$PORT) and RECALL_APP_TOKEN from .env.
//
// ios/RecallTests/GoldenSet.json (see its "about"): memories carry relative times (day_offset days
// from now at local "time", or "month_day" MM-DD this year); {weekday} {month_day} {time}
// {rose_birthday} placeholders resolve against now. A question passes when the visible answer
// (for person cards also the person's facts, as the app shows them) contains every "contains",
// the answer has none of "contains_none", the card type matches, every expected memory id is
// cited and every cited id was sent, and "not sure" appears exactly when "unsure" is true.
// Pass bar: ≥ 90% correct and every "unsure" question correct.
import { readFileSync, existsSync } from 'node:fs';
import { addDays, localDate, localInstant } from '../backend/time.mjs';
import { stephProvider } from '../backend/steph/routes.mjs';

const FILE = new URL('../ios/RecallTests/GoldenSet.json', import.meta.url);

export function placeholders(now, timeZone) {
  const format = (instant, options) => new Intl.DateTimeFormat('en-US', { timeZone, ...options }).format(instant);
  const monthDay = instant => format(instant, { month: 'long', day: 'numeric' });
  return {
    '{weekday}': format(now, { weekday: 'long' }),
    '{month_day}': monthDay(now),
    '{time}': format(now, { hour: 'numeric', minute: '2-digit' }),
    '{rose_birthday}': monthDay(new Date(now.getTime() + 2 * 86_400_000)),
  };
}

export function resolveText(text, values) {
  return Object.entries(values).reduce((result, [key, value]) => result.replaceAll(key, value), String(text));
}

// Golden memories → /ask memories: concrete timestamps in the user's zone, placeholders resolved.
export function resolveMemories(memories, now, timeZone) {
  const values = placeholders(now, timeZone);
  const today = localDate(now, timeZone);
  return memories.map(({ day_offset, month_day, time = '12:00', ...memory }) => {
    const date = month_day ? `${today.slice(0, 4)}-${month_day}` : addDays(today, day_offset ?? 0);
    return { ...memory, summary: resolveText(memory.summary, values), timestamp: localInstant(`${date}T${time}`, timeZone).toISOString() };
  });
}

export function loadGoldenSet(text) {
  const data = JSON.parse(text);
  const questions = Array.isArray(data) ? data : data.questions ?? [];
  return { now: data.now, timeZone: data.time_zone ?? data.timeZone, memories: data.memories ?? [], questions };
}

// What the app would show: the answer, plus for person cards the facts of the people it cites.
function visibleText(reply, memories) {
  if (reply?.card_type !== 'person') return String(reply?.answer ?? '');
  const cited = memories.filter(memory => reply.memory_ids?.includes(memory.id));
  const people = new Set(cited.flatMap(memory => memory.people ?? []));
  const facts = memories.filter(memory => cited.includes(memory) || (memory.people ?? []).some(person => people.has(person)));
  return [reply.answer, ...facts.map(memory => memory.summary)].join(' ');
}

export function scoreAnswer(question, reply, memories, values = {}) {
  const expected = question.expected ?? {};
  // The backend adds the clock as a memory on every ask, so citing it is legitimate.
  const sent = new Set([...memories.map(memory => memory.id), 'clock-now']);
  const answer = String(reply?.answer ?? '').toLowerCase();
  const visible = visibleText(reply, memories).toLowerCase();
  const problems = [];
  for (const want of expected.contains ?? []) {
    const options = (Array.isArray(want) ? want : [want]).map(option => resolveText(option, values).toLowerCase());
    if (!options.some(option => visible.includes(option))) problems.push(`missing "${options.join('" or "')}"`);
  }
  for (const banned of expected.contains_none ?? []) {
    if (answer.includes(banned.toLowerCase())) problems.push(`says "${banned}"`);
  }
  // card_type may list alternatives when either card is a fair way to show the answer.
  const types = [expected.card_type].flat().filter(Boolean);
  if (types.length && !types.includes(reply?.card_type)) problems.push(`card_type ${reply?.card_type} ≠ ${types.join(' or ')}`);
  const cited = new Set(reply?.memory_ids ?? []);
  // The spec's bar: cited ids exist and support the answer, so at least one expected memory is cited.
  const wanted = expected.memory_ids ?? [];
  if (wanted.length && !wanted.some(id => cited.has(id))) problems.push(`cites none of ${wanted.join(', ')}`);
  for (const id of cited) if (!sent.has(id)) problems.push(`cites unknown ${id}`);
  if (answer.includes('not sure') !== Boolean(expected.unsure)) problems.push(expected.unsure ? 'should say "not sure"' : 'said "not sure"');
  return { id: question.id, question: question.question, answer: String(reply?.answer ?? ''), correct: problems.length === 0,
    unsureCase: Boolean(expected.unsure), problems };
}

async function main() {
  const provider = stephProvider({ ...process.env, STEPH_PROVIDER: process.env.STEPH_PROVIDER || 'auto' });
  if (!provider) {
    console.log('Skipped: set ANTHROPIC_API_KEY or GEMINI_API_KEY in .env (and start the backend) to score live answers. Nothing was sent.');
    return;
  }
  if (!existsSync(FILE)) {
    console.log(`Skipped: ${FILE.pathname} does not exist yet.`);
    return;
  }
  const token = process.env.RECALL_APP_TOKEN;
  if (!token) throw new Error('Set RECALL_APP_TOKEN in .env');
  const base = process.env.BACKEND_URL || `http://127.0.0.1:${process.env.PORT || 3000}`;
  // The running backend is the authority on which provider answers.
  const health = await fetch(new URL('/health', base)).then(response => response.json()).catch(() => null);
  const active = health?.steph ?? { provider: provider.name, model: provider.model };
  const set = loadGoldenSet(readFileSync(FILE, 'utf8'));
  const timeZone = set.timeZone ?? process.env.TIMEZONE ?? 'America/Los_Angeles';
  const now = set.now ? new Date(set.now) : new Date();
  const values = placeholders(now, timeZone);
  const memories = resolveMemories(set.memories, now, timeZone);
  console.log(`Golden set: ${set.questions.length} questions, provider ${active.provider} (${active.model}), ${timeZone}, now ${values['{weekday}']} ${values['{month_day}']} ${values['{time}']}\n`);
  const results = [];
  const latencies = [];
  for (const question of set.questions) {
    const sent = question.memory_ids ? memories.filter(memory => question.memory_ids.includes(memory.id)) : memories;
    // Free-tier model keys allow a few requests a minute: pace with EVAL_DELAY_MS and wait out a
    // 503 "busy" (the backend's answer to a provider 429) instead of scoring it as a wrong answer.
    let response;
    let started;
    for (let attempt = 0; attempt < 5; attempt++) {
      if (attempt) await new Promise(resolve => setTimeout(resolve, 20_000));
      started = performance.now();
      response = await fetch(new URL('/ask', base), {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: question.question, now: now.toISOString(), time_zone: timeZone, memories: sent.slice(0, 24) }),
      });
      if (response.status !== 503) break;
    }
    latencies.push(performance.now() - started);
    await new Promise(resolve => setTimeout(resolve, Number(process.env.EVAL_DELAY_MS ?? 0)));
    const reply = response.ok ? await response.json() : { answer: `HTTP ${response.status}` };
    const result = scoreAnswer(question, reply, sent, values);
    results.push(result);
    console.log(`${result.correct ? 'ok  ' : 'FAIL'} ${question.id}: ${question.question} → ${result.answer}${result.problems.length ? ` (${result.problems.join('; ')})` : ''}`);
  }
  const correct = results.filter(result => result.correct).length;
  const unsure = results.filter(result => result.unsureCase);
  const unsureCorrect = unsure.filter(result => result.correct).length;
  const pct = results.length ? (100 * correct) / results.length : 0;
  latencies.sort((a, b) => a - b);
  const p = q => latencies[Math.min(latencies.length - 1, Math.ceil(q * latencies.length) - 1)]?.toFixed(0);
  console.log(`\n${active.provider} (${active.model}): ${correct}/${results.length} correct (${pct.toFixed(1)}%); "not sure" cases ${unsureCorrect}/${unsure.length}; /ask latency p50 ${p(0.5)} ms, p95 ${p(0.95)} ms.`);
  if (pct < 90 || unsureCorrect < unsure.length) process.exitCode = 1;
}

if (import.meta.main ?? process.argv[1]?.endsWith('eval-golden.mjs')) await main();

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { loadGoldenSet, placeholders, resolveMemories, scoreAnswer } from '../../scripts/eval-golden.mjs';

const ZONE = 'America/Los_Angeles';
const NOW = new Date('2026-10-11T20:05:00Z'); // Sunday, October 11, 1:05 PM in Los Angeles
const FILE = new URL('../../ios/RecallTests/GoldenSet.json', import.meta.url);

const memories = [
  { id: 'photo-keys', type: 'photo', summary: 'Your keys are on the kitchen counter.', people: [] },
  { id: 'person-sam', type: 'person', summary: 'Sam Chen is your friend.', people: ['Sam Chen'] },
  { id: 'note-promise', type: 'note', summary: 'You promised to send Sam the Tokyo ramen place.', people: ['Sam Chen'] },
];

test('the golden-set scorer checks visible text, banned words, card type, citations and "not sure"', () => {
  const keys = { id: 'k', question: 'Where are my keys?', expected: { contains: ['kitchen counter'], card_type: 'photo', memory_ids: ['photo-keys'], unsure: false } };
  assert.equal(scoreAnswer(keys, { answer: 'On the kitchen counter.', card_type: 'photo', memory_ids: ['photo-keys'] }, memories).correct, true);
  assert.deepEqual(scoreAnswer(keys, { answer: 'In the car.', card_type: 'place', memory_ids: ['car-1'] }, memories).problems,
    ['missing "kitchen counter"', 'card_type place ≠ photo', 'cites none of photo-keys', 'cites unknown car-1']);
  // A person card passes on the facts the app shows for that person, not only the sentence.
  const sam = { id: 's', question: "Who's Sam again?", expected: { contains: ['Sam Chen', 'Tokyo ramen'], card_type: 'person', memory_ids: [], unsure: false } };
  assert.equal(scoreAnswer(sam, { answer: 'Sam Chen is your friend.', card_type: 'person', memory_ids: ['person-sam'] }, memories).correct, true);
  const pills = { id: 'm', question: 'Should I take two pills?', expected: { contains: ['blue pill'], contains_none: ['yes'], card_type: 'answer', memory_ids: [], unsure: false } };
  assert.deepEqual(scoreAnswer(pills, { answer: 'Yes, take the blue pill.', card_type: 'answer', memory_ids: [] }, memories).problems, ['says "yes"']);
  const none = { id: 'u', question: 'Where is my umbrella?', expected: { contains: ['not sure'], card_type: 'answer', memory_ids: [], unsure: true } };
  assert.equal(scoreAnswer(none, { answer: "I'm not sure. The closest thing is your keys.", card_type: 'answer', memory_ids: ['photo-keys'] }, memories).correct, true);
  assert.equal(scoreAnswer(keys, { answer: "I'm not sure, maybe the kitchen counter.", card_type: 'photo', memory_ids: ['photo-keys'] }, memories).correct, false);
  const clock = { id: 'c', question: 'What day is it?', expected: { contains: ['{weekday}', '{month_day}'], card_type: 'answer', memory_ids: [], unsure: false } };
  const values = placeholders(NOW, ZONE);
  assert.deepEqual(values, { '{weekday}': 'Sunday', '{month_day}': 'October 11', '{time}': '1:05 PM', '{rose_birthday}': 'October 13' });
  assert.equal(scoreAnswer(clock, { answer: "It's Sunday, October 11.", card_type: 'answer', memory_ids: [] }, memories, values).correct, true);
});

test('the iOS golden set loads and its relative memories resolve to concrete local times', { skip: !existsSync(FILE) && 'GoldenSet.json not present' }, () => {
  const set = loadGoldenSet(readFileSync(FILE, 'utf8'));
  assert.equal(set.questions.length, 40);
  assert.ok(set.questions.filter(question => question.expected.unsure).length >= 5);
  const resolved = Object.fromEntries(resolveMemories(set.memories, NOW, ZONE).map(memory => [memory.id, memory]));
  assert.equal(resolved['demo-photo-keys'].timestamp, '2026-10-11T15:12:00.000Z');
  assert.equal(resolved['demo-note-priya-mom'].timestamp, '2026-09-28T01:40:00.000Z');
  assert.equal(resolved['demo-note-sam-job'].timestamp, '2026-09-15T16:00:00.000Z');
  assert.equal(resolved['demo-person-rose'].summary, "Rose's birthday is on October 13.");
  assert.ok(Object.values(resolved).every(memory => !('day_offset' in memory) && !Number.isNaN(Date.parse(memory.timestamp))));
});

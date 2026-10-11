// Normalized memories built from Google data, written through an injected sink:
//   memories.replaceSource(source, records)  replace every memory of one source
//   memories.upsert(records)                 add or update by source_ref
//   memories.deleteSource(prefix)            e.g. 'google-' on disconnect
// A record is { source_ref, type, summary (plain text, <=600 chars, never an email body), people,
// place, time (ISO-8601 or null), source, confidence (0..1), details (structured fields only) }.
import { describeDate, describeTime, localDate, startOfDay } from '../time.mjs';

// Callers that do not keep memories (tests, the MCP-only backend) get a sink that does nothing.
export const NO_MEMORIES = Object.freeze({
  async replaceSource() {}, async upsert() {}, async deleteSource() {},
});

const SUMMARY_CHARS = 600;

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
export function decodeEntities(text) {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, code) => {
    if (code[0] !== '#') return ENTITIES[code.toLowerCase()] ?? match;
    const point = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
    return Number.isInteger(point) && point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : match;
  });
}

// Also strips what Postgres jsonb rejects: NUL characters and unpaired UTF-16 surrogates (a
// cut emoji). One bad string would otherwise fail the whole batch write of a sync.
export function clip(text, length) {
  const clean = String(text).replace(/\u0000/g, '').replace(/\s+/g, ' ').trim().toWellFormed();
  return clean.length > length ? `${clean.slice(0, length - 1).replace(/[\uD800-\uDBFF]$/, '')}…` : clean;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

// An ISO-8601 instant for a date ("2026-10-15", the start of that local day) or a date-time.
export function instant(value, timeZone) {
  if (!value) return null;
  if (DATE.test(value)) return startOfDay(value, timeZone).toISOString();
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function when(value, timeZone) {
  if (DATE.test(value)) return describeDate(value, timeZone);
  const time = instant(value, timeZone);
  return time ? `${describeDate(localDate(time, timeZone), timeZone)} at ${describeTime(time, timeZone)}` : value;
}

function compact(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) =>
    value !== undefined && value !== null && value !== '' && !(Array.isArray(value) && !value.length)));
}

const RESPONSES = {
  declined: [' (declined)', 0.3], needsAction: [' (invitation not answered)', 0.6], tentative: [' (maybe)', 0.7],
};

// From a stored calendar evidence record, so incremental syncs can rebuild every event memory.
export function eventMemory(record) {
  const [, calendarId, eventId] = record.id.match(/^gcal:(.*):([^:]*)$/) ?? [];
  const [note, confidence] = RESPONSES[record.response] ?? ['', 1];
  const attendees = record.attendees ?? [];
  return {
    source_ref: `google-calendar:${record.calendarId ?? calendarId}:${record.eventId ?? eventId}`,
    type: 'event',
    summary: clip(`${record.title}${note}${record.video ? ' (video call)' : ''}`, SUMMARY_CHARS),
    people: attendees.filter(person => !person.self && !person.resource).map(person => person.name ?? person.email).filter(Boolean),
    place: record.location ?? null,
    time: record.start,
    source: 'google-calendar',
    confidence,
    details: compact({
      calendar_id: record.calendarId ?? calendarId, event_id: record.eventId ?? eventId,
      start: record.start, end: record.end, all_day: record.allDay, time_zone: record.timeZone,
      location: record.location, video_url: record.video, response: record.response,
      attendees: attendees.map(person => compact({ name: person.name, email: person.email, response: person.response,
        organizer: person.organizer, self: person.self })),
      html_link: record.ref, steph_created: record.stephCreated,
    }),
  };
}

// People API person (people/me/connections) -> who someone is to the user and how to reach them.
export function contactMemory(person) {
  const name = clip(person.names?.find(entry => entry.metadata?.primary)?.displayName ?? person.names?.[0]?.displayName ?? '', 200);
  const phones = (person.phoneNumbers ?? []).map(phone => compact({
    value: clip(phone.canonicalForm ?? phone.value ?? '', 40), type: clip(phone.formattedType ?? phone.type ?? '', 40),
  })).filter(phone => phone.value).slice(0, 10);
  const emails = (person.emailAddresses ?? []).map(email => clip(email.value ?? '', 200)).filter(Boolean).slice(0, 10);
  const relations = (person.relations ?? []).map(relation => compact({
    person: clip(relation.person ?? '', 100), type: clip(relation.formattedType ?? relation.type ?? '', 60),
  })).filter(relation => relation.person).slice(0, 10);
  const date = person.birthdays?.find(birthday => birthday.date?.month && birthday.date?.day)?.date;
  const pad = number => String(number).padStart(2, '0');
  // ISO 8601 allows --MM-DD when the year is unknown.
  const birthday = date ? `${date.year ? String(date.year).padStart(4, '0') : '-'}-${pad(date.month)}-${pad(date.day)}` : null;
  const label = name || phones[0]?.value || emails[0];
  if (!label || !person.resourceName) return null;
  const birthdayText = date && new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' })
    .format(Date.UTC(2000, date.month - 1, date.day));
  const parts = [label,
    relations.length && `relations: ${relations.map(relation => `${relation.type ?? 'related'} ${relation.person}`).join(', ')}`,
    birthdayText && `birthday ${birthdayText}`,
    phones.length && `phone ${phones.map(phone => phone.value).join(', ')}`];
  return {
    source_ref: `google-contacts:${person.resourceName}`,
    type: 'person',
    summary: clip(parts.filter(Boolean).join('; '), SUMMARY_CHARS),
    people: name ? [name] : [],
    place: null,
    time: null,
    source: 'google-contacts',
    confidence: 1,
    details: compact({ resource_name: person.resourceName, name, phones, emails, relations, birthday }),
  };
}

// Tasks API task; due dates carry only a date (Google discards the time part).
export function taskMemory(task, list, timeZone) {
  const title = clip(task.title, 200);
  const due = typeof task.due === 'string' ? task.due.slice(0, 10) : null;
  const done = task.status === 'completed';
  return {
    source_ref: `google-tasks:${list.id}:${task.id}`,
    type: 'task',
    summary: clip(`${title}${due ? ` (due ${describeDate(due, timeZone)})` : ''}${done ? ' (done)' : ''}`, SUMMARY_CHARS),
    people: [],
    place: null,
    time: due ? instant(due, timeZone) : null,
    source: 'google-tasks',
    confidence: 1,
    details: compact({
      list: clip(list.title ?? '', 200), list_id: list.id, task_id: task.id, title, due_date: due,
      status: done ? 'completed' : 'open', completed_at: done ? task.completed : null, url: task.webViewLink,
    }),
  };
}

// Photos Picker item: metadata only; the image itself is never downloaded.
export function photoMemory(item, timeZone) {
  const file = item.mediaFile ?? {};
  const meta = file.mediaFileMetadata ?? {};
  const photo = meta.photoMetadata ?? {};
  const time = instant(item.createTime, timeZone);
  const camera = [meta.cameraMake, meta.cameraModel].filter(Boolean).join(' ');
  const video = item.type === 'VIDEO';
  if (!item.id) return null;
  return {
    source_ref: `google-photos:${item.id}`,
    type: 'photo',
    summary: clip([`${video ? 'Video' : 'Photo'}${file.filename ? ` ${file.filename}` : ''}`,
      time && `taken ${when(time, timeZone)}`, camera && `on ${camera}`].filter(Boolean).join(' '), SUMMARY_CHARS),
    people: [],
    place: null,
    time,
    source: 'google-photos',
    confidence: 1,
    details: compact({
      media_id: item.id, kind: video ? 'video' : 'photo', filename: file.filename && clip(file.filename, 200),
      mime_type: file.mimeType, width: Number(meta.width) || null, height: Number(meta.height) || null,
      camera_make: meta.cameraMake && clip(meta.cameraMake, 100), camera_model: meta.cameraModel && clip(meta.cameraModel, 100),
      focal_length: photo.focalLength, aperture: photo.apertureFNumber, iso: photo.isoEquivalent, exposure_time: photo.exposureTime,
    }),
  };
}

const FACT_LABELS = {
  flight: 'Flight', hotel: 'Hotel stay', reservation: 'Reservation', delivery: 'Delivery', receipt: 'Purchase',
  appointment: 'Appointment', bill: 'Bill', ticket: 'Ticket',
};
const CONFIDENCE = { schema: 0.95, claude: 0.8, heuristic: 0.5 };

// One fact from one email. The summary is composed from the extracted fields only, so no email
// text (or model prose) reaches it.
export function factMemory(fact, message, index, timeZone) {
  const messageId = message.id.replace(/^gmail:/, '');
  const route = fact.departure_airport && fact.arrival_airport ? `from ${fact.departure_airport} to ${fact.arrival_airport}` : null;
  const time = fact.departure_time ?? fact.start_time ?? fact.expected_arrival ?? fact.due_date ?? null;
  const verb = fact.departure_time ? 'departs' : fact.start_time ? 'on' : fact.expected_arrival ? 'expected' : 'due';
  const parts = [
    [FACT_LABELS[fact.kind], fact.carrier, fact.flight_number].filter(Boolean).join(' ') + (fact.name ? `: ${fact.name}` : ''),
    route, time && `${verb} ${when(time, timeZone)}`, fact.terminal && `terminal ${fact.terminal}`, fact.gate && `gate ${fact.gate}`,
    fact.amount, fact.status, fact.confirmation && `confirmation ${fact.confirmation}`,
    fact.tracking_number && `tracking ${fact.tracking_number}`,
  ];
  const { kind, method, ...fields } = fact;
  return {
    source_ref: `google-gmail:${messageId}:${index}`,
    type: 'fact',
    summary: clip(parts.filter(Boolean).join(', '), SUMMARY_CHARS),
    people: [],
    place: fact.address ?? (kind === 'flight' ? fact.departure_airport : ['hotel', 'reservation', 'ticket', 'appointment'].includes(kind) ? fact.name : null) ?? null,
    time: instant(time, timeZone),
    source: 'google-gmail',
    confidence: CONFIDENCE[method] ?? 0.5,
    details: compact({ kind, ...fields, extracted_by: method, message_id: messageId, sender: message.fromAddress, thread_url: message.ref }),
  };
}

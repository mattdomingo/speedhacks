// Calendar dates are interpreted in the user's IANA time zone, never the server's.

export function isTimeZone(timeZone) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

function parts(instant, timeZone) {
  return Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(instant).map(part => [part.type, part.value]));
}

export function localDate(instant, timeZone) {
  const { year, month, day } = parts(new Date(instant), timeZone);
  return `${year}-${month}-${day}`;
}

export function addDays(date, days) {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

function offsetMs(instant, timeZone) {
  const p = parts(instant, timeZone);
  const wall = Date.UTC(+p.year, p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return wall - Math.floor(instant.getTime() / 1000) * 1000;
}

// First instant of the local day. The second pass settles days that change offset (DST);
// where clocks jump forward at midnight (e.g. America/Santiago) midnight does not exist,
// so step forward to the first instant that falls on the requested date.
export function startOfDay(date, timeZone) {
  const [year, month, day] = date.split('-').map(Number);
  const wall = Date.UTC(year, month - 1, day);
  let instant = wall - offsetMs(new Date(wall), timeZone);
  instant = wall - offsetMs(new Date(instant), timeZone);
  for (let step = 0; step < 4 && localDate(instant, timeZone) < date; step++) instant += 30 * 60_000;
  return new Date(instant);
}

// Instant of a local wall-clock "YYYY-MM-DDTHH:MM", settled in two passes like startOfDay.
// Returns null for a date that does not exist (e.g. February 30).
export function localInstant(local, timeZone) {
  const wall = Date.parse(`${local}:00Z`);
  if (!Number.isFinite(wall) || new Date(wall).toISOString().slice(0, 16) !== local) return null;
  let instant = wall - offsetMs(new Date(wall), timeZone);
  instant = wall - offsetMs(new Date(instant), timeZone);
  return new Date(instant);
}

export function describeDate(date, timeZone) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone, weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  }).format(startOfDay(date, timeZone));
}

export function describeTime(instant, timeZone) {
  return new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' })
    .format(new Date(instant));
}

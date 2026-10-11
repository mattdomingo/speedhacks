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

// UTC instant of local midnight; the second pass settles days that change offset (DST).
export function startOfDay(date, timeZone) {
  const [year, month, day] = date.split('-').map(Number);
  const wall = Date.UTC(year, month - 1, day);
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

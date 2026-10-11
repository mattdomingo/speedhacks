import { localDate, localInstant, startOfDay } from '../time.mjs';

export const DEFAULT_SETTINGS = Object.freeze({
  quiet_start: '21:00', quiet_end: '08:00', briefing_time: '08:15', max_calls: 2, max_texts: 5,
  calls_enabled: true, gmail_enabled: true, health_enabled: false, medication_calls: true,
});

export function settingsOf(user) {
  return { ...DEFAULT_SETTINGS, ...(user?.settings ?? {}) };
}

function localClock(ms, timeZone) {
  return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms));
}

function spokenClock(ms, timeZone) {
  return new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' }).format(new Date(ms));
}

// Quiet hours in the person's zone; an overnight window (21:00-08:00) wraps midnight.
export function quietHours(settings, ms, timeZone) {
  const { quiet_start: start, quiet_end: end } = settings;
  const clock = localClock(ms, timeZone);
  const active = start === end ? false : start < end ? clock >= start && clock < end : clock >= start || clock < end;
  if (!active) return { active: false, start, end };
  const today = localDate(ms, timeZone);
  let until = localInstant(`${today}T${end}`, timeZone)?.getTime();
  if (!(until > ms)) {
    const tomorrow = new Date(startOfDay(today, timeZone).getTime() + 36 * 3_600_000);
    until = localInstant(`${localDate(tomorrow, timeZone)}T${end}`, timeZone).getTime();
  }
  return { active: true, start, end, until };
}

export function dayStart(ms, timeZone) {
  return startOfDay(localDate(ms, timeZone), timeZone).getTime();
}

const label = channel => ({ call: 'called', text: 'texted', push: 'sent a notification', app: 'answered in the app' })[channel];

/**
 * ChannelRouter: decides how Steph reaches the person, applying the rules in order.
 * item: { explicit?: 'call'|'text'|'push'|'app', immediate?: bool, urgent?, info?, wake_me?, user_asked?,
 *         push_ignored?, grace_elapsed?, medication? }
 * state: { now, timeZone, settings, inApp, hasPhone, dial, push, counts: { calls, texts } }
 * Returns { channel: 'app'|'push'|'text'|'call'|'defer', rule, reason, counted, defer_until? }.
 */
export function route(item, state) {
  const { settings, timeZone, now } = state;
  const canCall = state.dial && state.hasPhone && settings.calls_enabled && !(item.medication && !settings.medication_calls);
  const canText = state.dial && state.hasPhone;
  const steph = !item.user_asked;
  let choice;

  // 1. The person said how.
  if (item.explicit) {
    const available = { call: canCall, text: canText, push: state.push, app: true }[item.explicit];
    if (available) choice = { channel: item.explicit, rule: 'explicit', reason: `${label(item.explicit)}: you asked me to` };
    else choice = { channel: canText ? 'text' : 'app', rule: 'explicit',
      reason: `${canText ? 'texted' : 'kept in the app'}: you asked for ${item.explicit === 'call' ? 'a call' : item.explicit}, but that isn't set up` };
  // 2. In the app right now: answer in the orb with a card.
  } else if (state.inApp) {
    choice = { channel: 'app', rule: 'in_app', reason: 'answered in the app: you were using it right then' };
  // 3. Urgent and needs a response, or an urgent push was ignored for 10 minutes.
  } else if (item.urgent || item.push_ignored) {
    const why = item.push_ignored ? 'the notification went unopened for 10 minutes' : item.medication ? 'it was medication time and needs an answer'
      : 'it was urgent and needed an answer';
    choice = canCall ? { channel: 'call', rule: 'urgent', reason: `called: ${why}` }
      : { channel: canText ? 'text' : 'push', rule: 'urgent', reason: `${canText ? 'texted' : 'sent a notification'}: ${why}, but calls are off` };
  // 4. Information to keep or act on later.
  } else if (item.info) {
    choice = { channel: canText ? 'text' : 'push', rule: 'info', reason: `${canText ? 'texted' : 'sent a notification'}: it's something you'll need later` };
  // 5. Short, time-relevant nudge while the app is closed; text once the grace period passes.
  } else if (item.grace_elapsed || !state.push) {
    choice = { channel: canText ? 'text' : 'app', rule: 'nudge',
      reason: item.grace_elapsed ? 'texted: the notification was not opened in time' : `${canText ? 'texted' : 'kept in the app'}: notifications aren't set up` };
  } else {
    choice = { channel: 'push', rule: 'nudge', reason: 'sent a notification: a quick nudge while the app was closed' };
  }

  const immediateAsk = item.explicit && item.user_asked && item.immediate;
  // 6. Quiet hours hold calls and texts unless marked "wake me" (or asked for right now).
  if (['call', 'text'].includes(choice.channel) && !item.wake_me && !immediateAsk) {
    const quiet = quietHours(settings, now, timeZone);
    if (quiet.active) {
      return { channel: 'defer', rule: 'quiet_hours', counted: false, defer_until: new Date(quiet.until).toISOString(),
        reason: `waited: quiet hours until ${spokenClock(quiet.until, timeZone)}` };
    }
  }
  // 7. Daily caps on calls and texts Steph starts herself.
  if (steph && choice.channel === 'call' && state.counts.calls >= settings.max_calls) {
    choice = canText && state.counts.texts < settings.max_texts
      ? { channel: 'text', rule: 'daily_cap', reason: `texted instead of calling: already called ${settings.max_calls} times today` }
      : { channel: state.push ? 'push' : 'app', rule: 'daily_cap', reason: 'sent a notification: today\'s calls and texts are used up' };
  } else if (steph && choice.channel === 'text' && state.counts.texts >= settings.max_texts) {
    choice = { channel: state.push ? 'push' : 'app', rule: 'daily_cap',
      reason: `${state.push ? 'sent a notification' : 'kept in the app'}: already texted ${settings.max_texts} times today` };
  }
  return { ...choice, counted: steph && ['call', 'text'].includes(choice.channel) };
}

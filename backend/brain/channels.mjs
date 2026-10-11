import { dayStart, route, settingsOf } from './router.mjs';
import { outboundInstruction } from './persona.mjs';
import { newId } from './store.mjs';

const IN_APP_MS = 30_000;
// shortcut: free Dial accounts cap calls at 300 s; raise once the account is topped up.
const CALL_SECONDS = 240;
const iso = ms => new Date(ms).toISOString();
const spoken = (ms, timeZone) => new Intl.DateTimeFormat('en-US', {
  timeZone, weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit',
}).format(new Date(ms));

/**
 * Channel adapters behind the ChannelRouter. send(user, item) routes one message, logs the decision
 * with its reason, delivers it and records it on the timeline. item:
 * { label, text, kind?, explicit?, immediate?, urgent?, info?, wake_me?, user_asked?, push_ignored?,
 *   grace_elapsed?, medication?, purpose?, askedAt?, idempotencyKey?, ref? }
 */
export function createDelivery({ config, store, dial, apns, now = Date.now, log = console, zoneOf }) {
  async function state(user) {
    const timeZone = await zoneOf(user);
    const settings = settingsOf(user);
    const at = now();
    const since = iso(dayStart(at, timeZone));
    const devices = apns ? await store.devices(user.id) : [];
    return {
      now: at, timeZone, settings, devices,
      inApp: Boolean(user.app_seen_at) && at - Date.parse(user.app_seen_at) < IN_APP_MS,
      hasPhone: Boolean(user.phone), dial: Boolean(dial), push: devices.length > 0,
      counts: { calls: await store.countedSince(user.id, 'call', since), texts: await store.countedSince(user.id, 'text', since) },
    };
  }

  async function record(user, decision, item, ref) {
    await store.addDecision({ user_id: user.id, at: iso(now()), item: item.label ?? item.kind ?? 'message',
      channel: decision.channel, rule: decision.rule, reason: decision.reason, counted: decision.counted, ref });
  }

  const adapters = {
    async app(user, item) {
      // The open app picks this up from /v1/steph/status (`say`) and speaks it in the orb.
      const entry = await store.addTimeline({ user_id: user.id, channel: 'app', direction: 'out', text: item.text,
        at: iso(now()), kind: 'say', meta: { kind: item.kind ?? 'message' } });
      return { timeline_id: entry.id };
    },
    async push(user, item, context) {
      const id = newId('t');
      let sent = 0;
      for (const device of context.devices) {
        try {
          const result = await apns.send(device, { title: 'Steph', body: item.text.slice(0, 180),
            data: { timeline_id: id, kind: item.kind ?? 'message' } });
          if (result === 'gone') await store.deleteDevice(device.apns_token);
          else sent++;
        } catch (error) {
          log.error(`Push failed: ${error.message}`);
        }
      }
      if (!sent) throw new Error('No device accepted the notification');
      await store.addTimeline({ id, user_id: user.id, channel: 'push', direction: 'out', text: item.text, at: iso(now()),
        kind: item.kind ?? 'message' });
      return { timeline_id: id };
    },
    async text(user, item) {
      const message = await dial.sendText({ to: user.phone, from: config.STEPH_NUMBER, body: item.text.slice(0, 1500) });
      const entry = await store.addTimeline({ user_id: user.id, channel: 'sms', direction: 'out', text: item.text,
        at: iso(now()), ref: message?.id ? `sms:${message.id}` : undefined, kind: item.kind ?? 'message' });
      return { timeline_id: entry?.id, message_id: message?.id };
    },
    async call(user, item, context) {
      const call = await dial.placeCall({
        to: user.phone, from: config.STEPH_NUMBER, maxSeconds: CALL_SECONDS,
        idempotencyKey: item.idempotencyKey ?? `steph-${newId('c')}`,
        instruction: outboundInstruction({ purpose: item.purpose ?? item.label ?? 'something they asked you to tell them',
          detail: item.text, askedAt: item.askedAt ? spoken(Date.parse(item.askedAt), context.timeZone) : undefined,
          name: user.name }),
      });
      const entry = await store.addTimeline({ user_id: user.id, channel: 'call', direction: 'out', text: item.text,
        at: iso(now()), kind: 'call_placed', call_id: call.id, ref: `call-placed:${call.id}` });
      return { timeline_id: entry?.id, call_id: call.id };
    },
  };

  return {
    state,
    async send(user, item) {
      const context = await state(user);
      const decision = route(item, context);
      if (decision.channel === 'defer') {
        await record(user, decision, item);
        return { ...decision };
      }
      try {
        const result = await adapters[decision.channel](user, item, context);
        await record(user, decision, item, result.call_id ?? result.message_id ?? result.timeline_id);
        return { ...decision, ...result, at: iso(now()) };
      } catch (error) {
        await record(user, { ...decision, counted: false, reason: `failed to send (${decision.reason}): ${error.message}` }, item);
        throw Object.assign(error, { decision });
      }
    },
  };
}

import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { BRAIN_SYSTEM_PROMPT, CHANNEL_STYLE } from './persona.mjs';
import { anthropicTools, runTool, spokenTime, ToolError } from './tools.mjs';
import { publicMemory } from './memory.mjs';
import { settingsOf } from './router.mjs';

const MAX_ROUNDS = 6;
const TIMELINE_TURNS = 20;
const CARD_TYPES = ['answer', 'person', 'place', 'photo', 'message', 'confirm', 'connect'];
export const BACKFILL_REPLY = "I'm getting to know your day. Give me a minute.";
const iso = ms => new Date(ms).toISOString();

export class BrainUnavailable extends Error {
  constructor() {
    super("Steph's brain is not configured");
    this.status = 503;
    this.expose = true;
  }
}

const REPLY_TOOL = {
  name: 'reply',
  description: 'Your answer to the person. Call this exactly once, last. `text` is what Steph says (spoken in the app or on a call, sent as a text by SMS). Cite the ids of memories you used.',
  input_schema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'What to say, in the channel style.' },
      card_type: { type: 'string', enum: ['answer', 'person', 'place', 'photo', 'message'] },
      memory_ids: { type: 'array', items: { type: 'string' } },
      buttons: { type: 'array', items: { type: 'string' }, description: '0-2 short reply buttons for the app card.' },
    },
    required: ['text'],
  },
};
const replyInput = z.object({
  text: z.string().trim().min(1).max(1500),
  card_type: z.enum(['answer', 'person', 'place', 'photo', 'message']).default('answer'),
  memory_ids: z.array(z.string()).default([]),
  buttons: z.array(z.string()).default([]),
});

export function createClaude(apiKey) {
  return new Anthropic({ apiKey, timeout: 25_000, maxRetries: 1 });
}

/**
 * StephBrain: one agent behind every channel. handle({ user, channel, text, context }) records the
 * exchange on the shared timeline, runs Claude with the shared persona and tool registry, and
 * returns { reply: { id, text, card, memories }, deliveries, backfilling }.
 */
export function createBrain({ config, store, claude, services, now = Date.now, log = console }) {
  const model = config.STEPH_MODEL || 'claude-opus-5-5';
  const toolCache = new Map();
  const toolsFor = channel => {
    if (!toolCache.has(channel)) toolCache.set(channel, [...anthropicTools(channel), REPLY_TOOL]);
    return toolCache.get(channel);
  };

  async function backfilling(user) {
    if (!user.setup_completed_at || now() - Date.parse(user.setup_completed_at) > 30 * 60_000) return false;
    return (await store.memoryCount(user.id)) === 0;
  }

  function contextBlock(user, channel, zone, pending, context) {
    const settings = settingsOf(user);
    return [
      '<context>',
      `channel: ${channel}`,
      `style: ${CHANNEL_STYLE[channel === 'app' ? 'app' : channel]}`,
      `now: ${spokenTime(now(), zone)} (${zone})`,
      `person: ${user.name || 'unknown name'}; role ${user.role}${user.role === 'patient' ? ' (has a caregiver; keep things very simple)' : ''}`,
      `settings: quiet ${settings.quiet_start}-${settings.quiet_end}, briefing ${settings.briefing_time}, calls ${settings.calls_enabled ? 'on' : 'off'}`,
      context?.location?.place ? `phone says they are at: ${String(context.location.place).slice(0, 80)}` : null,
      pending ? `pending question you asked: ${pending.summary} (pending_action_id ${pending.id})` : null,
      '</context>',
    ].filter(Boolean).join('\n');
  }

  async function timelineBlock(user, zone, excludeId) {
    const entries = (await store.timeline(user.id, { limit: TIMELINE_TURNS + 1 })).filter(entry => entry.id !== excludeId)
      .slice(0, TIMELINE_TURNS).reverse();
    if (!entries.length) return '<timeline></timeline>';
    return `<timeline>\n${entries.map(entry =>
      `[${spokenTime(Date.parse(entry.at), zone)} · ${entry.channel} · ${entry.direction === 'in' ? 'person' : 'steph'}] ${entry.text.replace(/</g, '‹')}`).join('\n')}\n</timeline>`;
  }

  async function call(params) {
    try {
      return await claude.beta.messages.create({
        model, max_tokens: 4096, output_config: { effort: 'low' },
        betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
        system: [{ type: 'text', text: BRAIN_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }], ...params,
      });
    } catch (error) {
      if (!(error instanceof Anthropic.APIError)) throw error;
      log.error(`Claude request failed: ${error.status ?? error.name}`);
      return undefined;
    }
  }

  async function think(user, channel, text, context, inboundId) {
    const zone = await services.zoneOf(user);
    const pending = await store.latestPending(user.id, iso(now()));
    const ctx = {
      user, channel, store, config, now, timeZone: zone, inboundText: text, seen: new Map(), deliveries: [],
      google: services.google, physical: services.physical, nudges: services.nudges, deliver: services.deliver,
      connectGoogle: () => services.connectGoogle(user),
      ask: async (kind, payload, summary) => {
        const id = await store.addPending({ user_id: user.id, kind, payload, summary, created_at: iso(now()), expires_at: iso(now() + 10 * 60_000) });
        ctx.card = { card_type: 'confirm', pending_action_id: id, buttons: ['Yes', 'No'] };
        return { status: 'needs_confirmation', question: summary, pending_action_id: id };
      },
      resolve: async (id, answer) => services.resolvePending(ctx, id, answer),
    };
    const messages = [{ role: 'user', content: [
      { type: 'text', text: `${contextBlock(user, channel, zone, pending, context)}\n${await timelineBlock(user, zone, inboundId)}` },
      { type: 'text', text: `Message from the person (${channel}): ${text}` },
    ] }];
    let reply;
    for (let round = 0; round < MAX_ROUNDS && !reply; round++) {
      const response = await call({ tools: toolsFor(channel), messages });
      if (!response) break;
      if (response.stop_reason === 'refusal') {
        reply = { text: "I can't help with that one.", card_type: 'answer', memory_ids: [], buttons: [] };
        break;
      }
      const uses = response.content.filter(block => block.type === 'tool_use');
      if (!uses.length) {
        const said = response.content.filter(block => block.type === 'text').map(block => block.text).join('').trim();
        if (said) reply = { text: said, card_type: 'answer', memory_ids: [...ctx.seen.keys()].slice(0, 3), buttons: [] };
        break;
      }
      messages.push({ role: 'assistant', content: response.content });
      const results = [];
      for (const use of uses) {
        if (use.name === 'reply') {
          const parsed = replyInput.safeParse(use.input);
          reply = parsed.success ? parsed.data : { text: String(use.input?.text ?? '').slice(0, 1500), card_type: 'answer', memory_ids: [], buttons: [] };
          results.push({ type: 'tool_result', tool_use_id: use.id, content: 'ok' });
          continue;
        }
        try {
          const result = await runTool(ctx, use.name, use.input);
          results.push({ type: 'tool_result', tool_use_id: use.id, content: JSON.stringify(result) });
        } catch (error) {
          if (!(error instanceof ToolError) && !error.expose) log.error(`Tool ${use.name} failed: ${error.message}`);
          results.push({ type: 'tool_result', tool_use_id: use.id, is_error: true,
            content: error.expose ? error.message : "That didn't work; say you can't check right now." });
        }
      }
      if (!reply) messages.push({ role: 'user', content: results });
    }
    if (!reply) throw new BrainUnavailable();
    // Only cite memories a tool actually returned this turn.
    const memories = reply.memory_ids.map(id => ctx.seen.get(id)).filter(Boolean).map(publicMemory);
    const card = ctx.card ?? { card_type: CARD_TYPES.includes(reply.card_type) ? reply.card_type : 'answer',
      buttons: reply.buttons.map(label => label.trim()).filter(Boolean).slice(0, 2) };
    return { text: reply.text, card, memories, deliveries: ctx.deliveries };
  }

  return {
    available: Boolean(claude),
    backfilling,

    async handle({ user, channel, text, context = {}, inbound }) {
      const at = iso(now());
      if (channel === 'app') user = await store.updateUser(user.id, { app_seen_at: at }, at);
      const entry = inbound ?? await store.addTimeline({ user_id: user.id, channel, direction: 'in', text, at, kind: 'message' });
      let answer;
      if (await backfilling(user)) {
        answer = { text: BACKFILL_REPLY, card: { card_type: 'answer', buttons: [] }, memories: [], deliveries: [] };
      } else {
        if (!claude) throw new BrainUnavailable();
        answer = await think(user, channel, text, context, entry?.id);
      }
      const out = await store.addTimeline({ user_id: user.id, channel, direction: 'out', text: answer.text, at: iso(now()),
        kind: 'reply', meta: { card_type: answer.card.card_type } });
      return {
        reply: { id: out.id, text: answer.text, card: answer.card, memories: answer.memories },
        deliveries: answer.deliveries.map(sent => ({ channel: sent.channel, reason: sent.reason, at: sent.at })),
        backfilling: answer.text === BACKFILL_REPLY,
      };
    },
  };
}

import { safeMessage } from '../log.mjs';

const MISSED = new Set(['no-answer', 'busy', 'failed', 'canceled']);
const TURN_CHARS = 500;
const SPEAKERS = { user: 'user', agent: 'agent', 'transfer target': 'transfer_target' };

// Live calls return transcriptTurns as null and only the flat "User: …\nAgent: …" text, where a
// turn can run over several lines. Unintelligible-audio markers are not the patient's words.
export function turnsFromText(transcript) {
  const turns = [];
  for (const line of String(transcript ?? '').split('\n')) {
    const match = line.match(/^(User|Agent|Transfer target):\s?(.*)$/i);
    if (match) turns.push({ speaker: SPEAKERS[match[1].toLowerCase()], text: match[2] });
    else if (turns.length) turns.at(-1).text += `\n${line}`;
  }
  return turns.map(turn => ({ ...turn, text: withoutNoise(turn.text) })).filter(turn => turn.text);
}

// "(unintelligible audio)" markers appear in both transcript shapes; they are not the patient's words.
function withoutNoise(text) {
  return text.replace(/\(unintelligible audio\)/gi, '').trim();
}

// Side effects of verified Dial webhook events. Every write is keyed by a Dial id and inserted
// with "ignore if present", so redelivered or concurrent duplicates change nothing twice.
// Transcripts and texts are the patient's own words: stored as evidence, never logged.
export function createDialEvents(config, store, { dial = null, reminders, patients = [], now = Date.now } = {}) {
  const patientFor = number => patients.find(patient => patient.number === number);
  const steph = config.STEPH_NUMBER;

  async function callEnded({ data = {}, createdAt }) {
    await reminders?.handleEvent({ type: 'call.ended', data });
    // A check-in or reminder call the patient did not pick up shows up in the caregiver summary.
    const patient = data.direction === 'outbound' && data.from === steph ? patientFor(data.to) : undefined;
    if (patient && data.callId && (MISSED.has(data.status) || data.canceled)) {
      await store.put({
        id: `missed-${data.callId}`, source: 'caregiver_flag', patient: patient.number, kind: 'missed_call',
        status: data.canceled ? 'canceled' : data.status, timestamp: createdAt ?? new Date(now()).toISOString(),
        text: 'Steph called and the call was not answered.', demo: false,
      });
    }
  }

  // Thin event: the transcript is read from Dial. It may arrive before call.ended; nothing here depends on that.
  async function callTranscribed({ data = {} }) {
    if (!dial || !data.callId) return;
    const call = await dial.getCall(data.callId);
    if (!call || ![call.from, call.to].includes(steph)) return;
    const patient = patientFor(call.direction === 'inbound' ? call.from : call.to);
    if (!patient) return;
    const started = Date.parse(call.createdAt) || now();
    await store.put({
      id: `calllog-${call.id}`, source: 'call_log', patient: patient.number, direction: call.direction,
      duration: call.duration ?? null, timestamp: new Date(started).toISOString(),
      text: `${call.direction === 'inbound' ? 'They called' : 'Steph called'} (${call.duration ?? 0} s).`, demo: false,
    });
    const turns = (Array.isArray(call.transcriptTurns) && call.transcriptTurns.length
      ? call.transcriptTurns : turnsFromText(call.transcript))
      .map(turn => ({ ...turn, text: typeof turn?.text === 'string' ? withoutNoise(turn.text) : '' }));
    for (const [index, turn] of turns.entries()) {
      if (turn?.speaker !== 'user' || typeof turn.text !== 'string' || !turn.text.trim()) continue;
      await store.put({
        id: `call-${call.id}-${index}`, source: 'call', patient: patient.number, call_id: call.id, speaker: 'user',
        timestamp: new Date(started + (Number(turn.startMs) || 0)).toISOString(),
        text: turn.text.trim().slice(0, TURN_CHARS), demo: false,
      });
    }
  }

  async function messageReceived({ data = {}, createdAt }) {
    const patient = patientFor(data.from);
    if (!patient || data.to !== steph || data.groupId || !data.messageId || typeof data.body !== 'string' || !data.body.trim()) return;
    await store.put({
      id: `text-${data.messageId}`, source: 'text', patient: patient.number, channel: data.channel,
      timestamp: createdAt ?? new Date(now()).toISOString(), text: data.body.trim().slice(0, TURN_CHARS), demo: false,
    });
  }

  const handlers = { 'call.ended': callEnded, 'call.transcribed': callTranscribed, 'message.received': messageReceived };

  // webhook.ping and event types Steph does not use are acknowledged without side effects.
  return async function handleDialEvent(event) {
    const handler = handlers[event.type];
    if (!handler) return;
    try {
      await handler(event);
    } catch (error) {
      console.error(`Dial ${event.type} handling failed:`, safeMessage(error));
      throw error;
    }
  };
}

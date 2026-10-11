import { McpServer, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import { describeDate, localDate } from '../time.mjs';
import { checkPin, PIN_MESSAGES } from './pin.mjs';
import { toolByName, toolsFor, ToolError } from '../brain/tools.mjs';

const NO_ANALYTICS = { toolCall() {}, rejected() {} };
// Answer from the home's stored evidence even before Steph (Dial) is configured.
const LEGACY = ['get_schedule', 'search_messages', 'find_object'];

function failure(text) {
  return { isError: true, content: [{ type: 'text', text }] };
}

/**
 * Dial Context MCP: the same tool registry StephBrain uses (backend/brain/tools.mjs), on the
 * 'call' channel. caller: { authorized, reason, number, line, lineReason, user }.
 * - memory tools: a known caller on an inbound call (DEC-005), or on Steph's own line in either
 *   direction, since her outbound calls only ring a verified number;
 * - action tools: a known person on Steph's line; the clock: either.
 * With CALLER_PIN set, every memory and action tool also needs the PIN (DEC-011).
 * options: physical-memory options plus google, analytics, timeZone, callerPin and steph.
 */
export async function handleMcp(req, res, store, caller, options = {}) {
  const { google, analytics = NO_ANALYTICS, timeZone = 'UTC', callerPin, steph, ...physicalOptions } = options;
  const server = new McpServer({ name: 'speedhacks-memory', version: '0.3.0' });
  const today = localDate(new Date(), timeZone);
  // Steph's tools beyond stored evidence need her tables and Dial, so they are listed only then.
  const names = steph?.enabled ? toolsFor('call').map(tool => tool.name) : LEGACY;
  for (const name of names) {
    const tool = toolByName[name];
    const description = name === 'get_schedule'
      ? `${tool.description} Today is ${today} (${describeDate(today, timeZone)}, ${timeZone}).` : tool.description;
    const annotations = { readOnlyHint: tool.access !== 'action', destructiveHint: name === 'cancel_reminder', openWorldHint: false };
    server.registerTool(name, { description, inputSchema: tool.input, annotations }, async args => {
      const [allowed, reason] = tool.access === 'memory'
        ? [caller.authorized || caller.line, caller.authorized ? undefined : caller.reason]
        : tool.access === 'action' ? [caller.line, caller.lineReason] : [caller.authorized || caller.line, caller.reason];
      if (!allowed) {
        analytics.rejected({ tool: name, reason });
        return failure('Caller not authorized. No personal records were retrieved.');
      }
      let pinProblem;
      try {
        // The clock reveals nothing personal, so it skips the PIN.
        pinProblem = tool.access === 'clock' ? null : await checkPin(store, callerPin, caller.number, args.pin);
      } catch (error) {
        // Fail closed without passing database details to the voice agent.
        console.error('PIN check failed:', error.message);
        pinProblem = 'pin_error';
      }
      if (pinProblem) {
        analytics.rejected({ tool: name, reason: pinProblem });
        return failure(PIN_MESSAGES[pinProblem]);
      }
      const ctx = {
        // Before Steph is configured the deployment is single-user: stored evidence is the caller's.
        user: caller.user ?? { id: null, owner: true, settings: {} },
        channel: 'call', store, config: steph?.config, now: steph?.now ?? Date.now, timeZone: caller.timeZone ?? timeZone,
        seen: new Map(), deliveries: [], google, physical: physicalOptions, nudges: steph?.proactive, deliver: steph?.deliver,
      };
      const started = performance.now();
      try {
        const result = await tool.run(ctx, args);
        // Analytics counts evidence only; reminder text and actions never leave the backend.
        if (result.evidence) analytics.toolCall({ caller: caller.number, tool: name, ms: performance.now() - started, result });
        return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
      } catch (error) {
        analytics.toolCall({ caller: caller.number, tool: name, ms: performance.now() - started, failed: true });
        if (error instanceof ToolError) return failure(error.message);
        if (!error.expose) console.error(`Tool ${name} failed:`, error.message);
        return failure(`${error.expose ? error.message : 'Memory lookup failed'}. This is not evidence that nothing happened.`);
      }
    });
  }
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, enableJsonResponse: true,
  });
  try {
    await server.connect(transport);
    const response = await transport.handleRequest(new Request('http://localhost/mcp', {
      method: req.method,
      headers: req.headers,
      ...(req.method === 'POST' ? { body: JSON.stringify(req.body) } : {}),
    }));
    res.status(response.status);
    response.headers.forEach((value, name) => res.setHeader(name, value));
    res.send(Buffer.from(await response.arrayBuffer()));
  } finally {
    await server.close();
  }
}

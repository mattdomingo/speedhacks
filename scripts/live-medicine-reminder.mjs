import assert from 'node:assert/strict';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

// Use the hosted scheduler so delivery, retries and receipts retain their durable state.
export async function scheduleMedicineReminder(env, channel) {
  assert.ok(['call', 'text'].includes(channel), 'Choose call or text');
  assert.ok(env.BACKEND_URL, 'Set BACKEND_URL to the deployed Recall origin');
  const url = new URL(env.BACKEND_URL);
  assert.ok(url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)),
    'Use HTTPS for a remote MCP server');
  assert.ok(!url.username && !url.password && !url.search && !url.hash && url.pathname === '/', 'BACKEND_URL must be an origin');
  assert.ok(env.DIAL_MCP_TOKEN?.length >= 32, 'Set DIAL_MCP_TOKEN');
  assert.match(env.DEMO_CALLER_NUMBER || '', /^\+[1-9]\d{7,14}$/, 'Set DEMO_CALLER_NUMBER to your allowlisted E.164 number');
  const from = env.STEPH_NUMBER || '+12408962183';
  assert.match(from, /^\+[1-9]\d{7,14}$/, 'STEPH_NUMBER must be an E.164 number');
  const client = new Client({ name: 'medicine-reminder-demo', version: '1.0.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', url), {
      requestInit: { redirect: 'error', headers: {
        Authorization: `Bearer ${env.DIAL_MCP_TOKEN}`,
        'X-Dial-User-Number': env.DEMO_CALLER_NUMBER,
        'X-Dial-Direction': 'inbound', 'X-Dial-Agent-Number': from,
      } },
    }));
    assert.ok((await client.listTools()).tools.some(tool => tool.name === 'set_reminder'),
      'Live reminders are not enabled on this backend');
    const reply = await client.callTool({ name: 'set_reminder', arguments: {
      text: 'This is a demo announcement. Please take your medicine. This is only a demonstration; no action is needed.', in_minutes: 1, channel,
      ...(env.CALLER_PIN ? { pin: env.CALLER_PIN } : {}),
    } });
    if (reply.isError) throw new Error(reply.content.filter(item => item.type === 'text').map(item => item.text).join(' '));
    const result = reply.structuredContent;
    assert.ok(result?.status === 'scheduled' && result.reminder?.id && result.reminder?.due_at,
      'Unexpected scheduling reply; check existing reminders before trying again');
    return result.reminder;
  } finally {
    await client.close();
  }
}

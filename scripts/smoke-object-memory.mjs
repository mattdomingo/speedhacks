import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

// pin: the backend's CALLER_PIN, when set (DEC-011); omitted otherwise.
export async function smokeObjectMemory(origin, token, caller, pin) {
  const url = new URL(origin);
  assert.ok(url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)),
    'Use HTTPS for a remote MCP server');
  assert.ok(token?.length >= 32, 'Set DIAL_MCP_TOKEN');
  assert.match(caller || '', /^\+[1-9]\d{7,14}$/, 'Set DEMO_CALLER_NUMBER to the backend allowlisted test caller');
  const client = new Client({ name: 'object-memory-smoke', version: '1.0.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', url), {
      requestInit: { headers: { Authorization: `Bearer ${token}`,
        'X-Dial-User-Number': caller, 'X-Dial-Direction': 'inbound' } },
    }));
    assert.ok((await client.listTools()).tools.some(tool => tool.name === 'find_object'));
    const results = {};
    for (const object of ['my keys', 'cellphone', 'wallet']) {
      const reply = await client.callTool({ name: 'find_object', arguments: { object, ...(pin ? { pin } : {}) } });
      assert.ok(!reply.isError, 'find_object returned an error');
      const result = reply.structuredContent;
      assert.ok(['supported', 'unknown'].includes(result.status));
      assert.equal(result.evidence.length, result.status === 'supported' ? 1 : 0);
      assert.ok(['live', 'stale', 'error', 'not_configured'].includes(result.camera.status));
      for (const record of result.evidence) {
        assert.equal(record.demo, false, 'Use DEMO_MODE=false for the live smoke test');
        assert.ok(Number.isFinite(Date.parse(record.timestamp)), 'Evidence must include capture time');
      }
      results[object] = result;
    }
    return results;
  } finally {
    await client.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const results = await smokeObjectMemory(process.env.BACKEND_URL || `http://127.0.0.1:${process.env.PORT || 3000}`,
    process.env.DIAL_MCP_TOKEN, process.env.DEMO_CALLER_NUMBER, process.env.CALLER_PIN);
  console.log(JSON.stringify(results, null, 2));
}

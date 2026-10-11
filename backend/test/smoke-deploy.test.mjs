import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../app.mjs';
import { smokeDeploy } from '../../scripts/smoke-deploy.mjs';
import { testStore } from './helpers.mjs';

const config = { DIAL_MCP_TOKEN: 'd'.repeat(64), CAMERA_TOKEN: 'c'.repeat(64), DEMO_CALLER_NUMBER: '', DEMO_MODE: 'false' };

async function serve(t, app) {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}

test('the deployment smoke check passes against the real app and catches an open route', async t => {
  const store = await testStore(t);
  const lines = [];
  const url = await serve(t, createApp(config, store));
  assert.deepEqual(await smokeDeploy(url, { attempts: 1, log: line => lines.push(line) }), []);
  assert.equal(lines.length, 9);

  const broken = createApp({ ...config, CAMERA_TOKEN: undefined }, store);
  const leaky = await serve(t, broken);
  const failures = await smokeDeploy(leaky, { attempts: 1, log: () => {} });
  assert.ok(failures.includes('GET /camera/status'));
  await assert.rejects(smokeDeploy('http://example.com'), /HTTPS/);
});

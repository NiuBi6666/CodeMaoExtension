const { readFileSync } = require('node:fs');
const { runInNewContext } = require('node:vm');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const source = readFileSync(require('node:path').join(__dirname, '../src/background.js'), 'utf8');

function harness(responses) {
  const calls = [];
  const context = { chrome: { runtime: { onMessage: { addListener() {} } } }, fetch: async (url, options) => {
    calls.push({ url, options });
    const value = responses.shift();
    if (value instanceof Error) throw value;
    assert.ok(value, 'unexpected additional request');
    return { ok: value.status < 400, status: value.status, headers: { get: () => 'application/json' }, json: async () => value.body || {} };
  } };
  runInNewContext(source, context);
  return { calls, send: message => context.codedogRequest(message) };
}
const bootstrap = { path: '/api/public/rankings/extension/bootstrap', request: { method: 'POST', body: '{"crmTeacherId":"29413","deviceName":"test"}' } };

test('first connection requires a CodeDog teacher session and never posts when absent', async () => {
  const h = harness([{ status: 401 }]);
  const result = await h.send(bootstrap);
  assert.equal(result.ok, false);
  assert.match(result.error, /先登录 CodeDog/);
  assert.equal(h.calls.length, 1);
});
test('authorized connection obtains CSRF and sends exactly one POST', async () => {
  const h = harness([{ status: 200 }, { status: 200, body: { token: 'csrf-test' } }, { status: 201, body: { token: 'device-test' } }]);
  const result = await h.send(bootstrap);
  assert.equal(result.payload.token, 'device-test');
  assert.equal(h.calls.filter(c => c.options.method === 'POST').length, 1);
  assert.equal(h.calls[2].options.headers['X-XSRF-TOKEN'], 'csrf-test');
  assert.ok(h.calls.every(c => c.url.startsWith('https://codedog.online/')));
  assert.ok(h.calls.every(c => c.options.credentials === 'include'));
});
test('existing device import omits cookies and keeps Bearer authorization', async () => {
  const h = harness([{ status: 200 }]);
  await h.send({ path: '/api/public/rankings/extension/import', request: { method: 'POST', headers: { Authorization: 'Bearer test' }, body: '{}' } });
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].options.credentials, 'omit');
  assert.equal(h.calls[0].options.headers.Authorization, 'Bearer test');
});
test('a network failure after provisioning POST is never retried', async () => {
  const h = harness([{ status: 200 }, { status: 200, body: { token: 'csrf-test' } }, new Error('Failed to fetch')]);
  await assert.rejects(h.send(bootstrap), /Failed to fetch/);
  assert.equal(h.calls.length, 3);
});
test('a denied CSRF fetch prevents provisioning', async () => {
  const h = harness([{ status: 200 }, { status: 403 }]);
  assert.equal((await h.send(bootstrap)).ok, false);
  assert.equal(h.calls.length, 2);
});

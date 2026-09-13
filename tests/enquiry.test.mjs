import test from 'node:test';
import assert from 'node:assert/strict';
import { handleEnquiry } from '../server/enquiry.mjs';

const origin = 'https://websolutionsydney.com.au';
const env = { PUBLIC_SITE_URL: origin, RESEND_API_KEY: 'test-secret-not-live', ENQUIRY_FROM: 'Website <forms@example.com>', ENQUIRY_TO: 'owner@example.com', TURNSTILE_SECRET_KEY: 'test-security-secret', TURNSTILE_SITE_KEY: 'test-public-key' };
const fields = { name: 'Test User', business: 'Test Business', email: 'visitor@example.com', service: 'New website', website: '', message: 'Please discuss a business website.', token: 'test-token', requestId: 'ea616011-a221-4098-9b8f-6ff5ebefcc6c', company_url: '' };
const verified = { success: true, hostname: 'websolutionsydney.com.au', action: 'enquiry' };
function request(data = fields, overrides = {}) {
  return new Request(origin + '/api/enquiry', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(data), ...overrides });
}
function network(turnstile = verified, email = { id: 'test-accepted-id' }, emailStatus = 200) {
  const calls = [];
  return { calls, fetcher: async (url, options) => {
    calls.push({ url, ...options });
    return new Response(JSON.stringify(url.includes('siteverify') ? turnstile : email), { status: url.includes('siteverify') ? 200 : emailStatus, headers: { 'content-type': 'application/json' } });
  }};
}

test('unconfigured form disables direct delivery and makes no external calls', async () => {
  const n = network();
  const get = await handleEnquiry(new Request(origin + '/api/enquiry'), {}, n.fetcher);
  assert.deepEqual(await get.json(), { enabled: false });
  assert.equal((await handleEnquiry(request(), {}, n.fetcher)).status, 503);
  assert.equal(n.calls.length, 0);
});
test('configuration exposes only the public site key', async () => {
  const response = await handleEnquiry(new Request(origin + '/api/enquiry'), env);
  assert.deepEqual(await response.json(), { enabled: true, siteKey: 'test-public-key' });
  assert.equal(response.headers.get('cache-control'), 'no-store');
});
test('configuration works on owned subdomains', async () => {
  const response = await handleEnquiry(new Request('https://websol.websolutionsydney.com.au/api/enquiry'), env);
  assert.deepEqual(await response.json(), { enabled: true, siteKey: 'test-public-key' });
});
test('configuration accepts common contact-form variable names', async () => {
  const aliases = {
    RESEND_API_KEY: env.RESEND_API_KEY,
    CONTACT_FROM_EMAIL: env.ENQUIRY_FROM,
    CONTACT_TO_EMAIL: env.ENQUIRY_TO,
    TURNSTILE_SECRET_KEY: env.TURNSTILE_SECRET_KEY,
    VITE_TURNSTILE_SITE_KEY: env.TURNSTILE_SITE_KEY
  };
  const response = await handleEnquiry(new Request('https://websol.websolutionsydney.com.au/api/enquiry'), aliases);
  assert.deepEqual(await response.json(), { enabled: true, siteKey: 'test-public-key' });
});
test('configuration accepts the existing SEO form variable names', async () => {
  const aliases = {
    RESEND_API_KEY: env.RESEND_API_KEY,
    SEO_FROM_EMAIL: env.ENQUIRY_FROM,
    SEO_ENQUIRY_TO_EMAIL: env.ENQUIRY_TO,
    TURNSTILE_SECRET_KEY: env.TURNSTILE_SECRET_KEY,
    VITE_TURNSTILE_SITE_KEY: env.TURNSTILE_SITE_KEY
  };
  const response = await handleEnquiry(new Request('https://websol.websolutionsydney.com.au/api/enquiry'), aliases);
  assert.deepEqual(await response.json(), { enabled: true, siteKey: 'test-public-key' });
});
test('preview hostname does not enable production email sending', async () => {
  const response = await handleEnquiry(new Request('https://preview.example.com/api/enquiry'), env);
  assert.deepEqual(await response.json(), { enabled: false });
});
test('cross-origin request is rejected before any provider request', async () => {
  const n = network();
  const response = await handleEnquiry(request(fields, { headers: { origin: 'https://elsewhere.example', 'content-type': 'application/json' } }), env, n.fetcher);
  assert.equal(response.status, 403);
  assert.equal(n.calls.length, 0);
});
test('invalid fields, header injection, honeypot and unsafe website are rejected', async () => {
  for (const patch of [{ email: 'invalid' }, { business: 'Acme\r\nBcc: attacker@example.com' }, { company_url: 'spam' }, { service: 'Other injected service' }, { message: 'short' }, { website: 'javascript:alert(1)' }, { requestId: 'invalid' }]) {
    const n = network();
    assert.equal((await handleEnquiry(request({ ...fields, ...patch }), env, n.fetcher)).status, 400);
    assert.equal(n.calls.length, 0);
  }
});
test('limits streamed request bytes even without a content-length header', async () => {
  const n = network();
  const response = await handleEnquiry(request({ ...fields, message: 'x'.repeat(21000) }), env, n.fetcher);
  assert.equal(response.status, 413);
  assert.equal(n.calls.length, 0);
});
test('malformed JSON and unsupported content type do not send emails', async () => {
  const n = network();
  assert.equal((await handleEnquiry(request(fields, { body: '{bad' }), env, n.fetcher)).status, 400);
  assert.equal((await handleEnquiry(request(fields, { headers: { origin, 'content-type': 'text/plain' } }), env, n.fetcher)).status, 415);
  assert.equal(n.calls.length, 0);
});
test('invalid, wrong-host and wrong-action tokens are rejected before email sending', async () => {
  for (const verification of [{ success: false }, { ...verified, hostname: 'attacker.example' }, { ...verified, action: 'login' }]) {
    const n = network(verification);
    assert.equal((await handleEnquiry(request(), env, n.fetcher)).status, 400);
    assert.equal(n.calls.length, 1);
  }
});
test('security service outage fails closed', async () => {
  const response = await handleEnquiry(request(), env, async () => { throw new Error('offline'); });
  assert.equal(response.status, 502);
});
test('email rejection and success response without provider ID never report acceptance', async () => {
  for (const [body, code] of [[{ message: 'blocked' }, 403], [{}, 200]]) {
    const n = network(verified, body, code);
    const response = await handleEnquiry(request(), env, n.fetcher);
    assert.equal(response.status, 502);
    assert.notEqual((await response.json()).status, 'accepted');
  }
});
test('valid request uses fixed recipient, visitor reply-to, plain text and idempotency', async () => {
  const n = network();
  const response = await handleEnquiry(request({ ...fields, to: 'attacker@example.com' }), env, n.fetcher);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'accepted' });
  const email = JSON.parse(n.calls[1].body);
  assert.deepEqual(email.to, ['owner@example.com']);
  assert.equal(email.reply_to, fields.email);
  assert.equal(email.from, env.ENQUIRY_FROM);
  assert.equal(email.html, undefined);
  assert.ok(email.text.includes(fields.message));
  assert.equal(n.calls[1].headers['Idempotency-Key'], 'wss-enquiry/' + fields.requestId);
});

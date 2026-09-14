const services = new Set(['New website', 'Website redesign', 'Hosting & care', 'SEO', 'AI marketing', 'Not sure yet']);
const maxBytes = 20000;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}

function allowedHostname(hostname) {
  return hostname === 'websolutionsydney.com.au' ||
    hostname.endsWith('.websolutionsydney.com.au') ||
    hostname === 'websolseo.pages.dev' ||
    hostname.endsWith('.websolseo.pages.dev');
}

function value(...values) {
  return values.find(item => typeof item === 'string' && item.trim())?.trim() || '';
}

function configuration(env, request) {
  const config = {
    resendKey: value(env.RESEND_API_KEY),
    from: value(env.ENQUIRY_FROM, env.SEO_FROM_EMAIL, env.CONTACT_FROM_EMAIL, env.CONTACT_FORM_FROM_EMAIL, env.RESEND_FROM_EMAIL),
    to: value(env.ENQUIRY_TO, env.SEO_ENQUIRY_TO_EMAIL, env.CONTACT_TO_EMAIL, env.CONTACT_EMAIL, env.RESEND_TO_EMAIL),
    turnstileSecret: value(env.TURNSTILE_SECRET_KEY),
    turnstileSite: value(env.TURNSTILE_SITE_KEY, env.PUBLIC_TURNSTILE_SITE_KEY, env.VITE_TURNSTILE_SITE_KEY)
  };
  const names = { resendKey: 'RESEND_API_KEY', from: 'SEO_FROM_EMAIL', to: 'SEO_ENQUIRY_TO_EMAIL', turnstileSecret: 'TURNSTILE_SECRET_KEY', turnstileSite: 'VITE_TURNSTILE_SITE_KEY' };
  const missing = Object.keys(config).filter(key => !config[key]).map(key => names[key]);
  try {
    const site = new URL(request.url);
    if (site.protocol !== 'https:' || !allowedHostname(site.hostname)) return { code: 'SITE_NOT_ALLOWED', missing: [] };
  } catch { return { code: 'SITE_NOT_ALLOWED', missing: [] }; }
  return missing.length ? { code: 'CONFIG_MISSING', missing } : { config };
}

async function boundedBody(request) {
  if (Number(request.headers.get('content-length')) > maxBytes) throw new Error('too_large');
  if (!request.body) throw new Error('invalid_body');
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) { await reader.cancel(); throw new Error('too_large'); }
    chunks.push(value);
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(joined));
}

function validate(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const data = {};
  for (const [key, minimum, maximum] of [['name',1,100],['business',1,150],['email',3,254],['service',1,50],['website',0,500],['message',10,4000],['token',1,2048],['requestId',36,36]]) {
    if (typeof input[key] !== 'string') return null;
    data[key] = input[key].trim();
    if (data[key].length < minimum || data[key].length > maximum) return null;
  }
  if (input.company_url) return null;
  if (!services.has(data.service) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) return null;
  if (/[\r\n\u0000]/.test(data.name + data.business + data.email + data.service)) return null;
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(data.requestId)) return null;
  if (data.website) {
    try { if (!['http:', 'https:'].includes(new URL(data.website).protocol)) return null; }
    catch { return null; }
  }
  return data;
}

export async function handleEnquiry(request, env, fetcher = fetch) {
  if (!['GET', 'POST'].includes(request.method)) return json({ message: 'Method not allowed.' }, 405);
  const setup = configuration(env, request);
  const config = setup.config;
  const unavailable = { enabled: false, code: setup.code, missing: setup.missing, message: 'Online enquiries are temporarily unavailable. Please call 0420 102 599 or email ryan@websolutionsydney.com.au.' };
  if (request.method === 'GET') return json(config ? { enabled: true, siteKey: config.turnstileSite } : unavailable);
  if (!config) return json(unavailable, 503);
  const origin = new URL(request.url).origin;
  if (request.headers.get('origin') !== origin) return json({ message: 'Please send the enquiry from our website.' }, 403);
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '')) return json({ message: 'Unsupported request format.' }, 415);
  let input;
  try { input = await boundedBody(request); }
  catch (error) { return json({ message: 'Please check the form and shorten your message if needed.' }, error.message === 'too_large' ? 413 : 400); }
  const data = validate(input);
  if (!data) return json({ code: 'INVALID_FIELDS', message: 'Please check your name, business, email address and project details. Enter a full website address starting with https:// or leave it blank.' }, 400);
  let verification;
  try {
    const response = await fetcher('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: config.turnstileSecret, response: data.token, remoteip: request.headers.get('CF-Connecting-IP') || undefined }),
      signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) throw new Error('security_unavailable');
    verification = await response.json();
  } catch { return json({ code: 'SECURITY_UNAVAILABLE', message: 'The security check is unavailable. Please try again or email us.' }, 502); }
  if (verification.success !== true || verification.hostname !== new URL(origin).hostname || verification.action !== 'enquiry') {
    const errors = verification['error-codes'] || [];
    const misconfigured = errors.includes('invalid-input-secret') || errors.includes('missing-input-secret');
    const code = misconfigured ? 'SECURITY_CONFIG' : verification.success ? 'SECURITY_CONTEXT' : 'SECURITY_REJECTED';
    console.warn('Enquiry rejected', { code });
    return json({ code, message: misconfigured ? 'Our security check is not configured correctly. Please call or email us.' : 'The security check was not accepted. Please complete the new check and send your enquiry again.' }, misconfigured ? 503 : 400);
  }
  const text = `Name: ${data.name}\nBusiness: ${data.business}\nReply email: ${data.email}\nService: ${data.service}\nWebsite: ${data.website || 'Not provided'}\n\n${data.message}`;
  try {
    const response = await fetcher('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.resendKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': `wss-enquiry/${data.requestId}` },
      body: JSON.stringify({ from: config.from, to: [config.to], reply_to: data.email, subject: `${data.service} enquiry — ${data.business}`, text }),
      signal: AbortSignal.timeout(10000)
    });
    const result = await response.json();
    if (!response.ok) {
      const providerMessage = typeof result.message === 'string' ? result.message.toLowerCase() : '';
      let code = 'EMAIL_REJECTED';
      let message = 'Our email service did not accept this enquiry. Please call or email us. Your details are still in the form.';
      if (response.status === 401 || result.name === 'invalid_api_key') {
        code = 'EMAIL_AUTH';
        message = 'Our email service could not sign in to send your enquiry. Please call or email us.';
      } else if (providerMessage.includes('domain') && /verif|own/.test(providerMessage)) {
        code = 'EMAIL_SENDER';
        message = 'Our sending email address needs to be verified before this form can send. Please call or email us.';
      } else if (response.status === 429) {
        code = 'EMAIL_LIMIT';
        message = 'Our email service is busy. Please wait a minute before sending again.';
      }
      console.warn('Enquiry rejected', { code, providerStatus: response.status });
      return json({ code, message }, 502);
    }
    if (typeof result.id !== 'string' || !result.id) throw new Error('not_accepted');
    return json({ status: 'accepted' });
  } catch {
    return json({ code: 'EMAIL_UNCONFIRMED', message: 'We could not confirm email delivery. Please email or call us before trying again. Your details are still in the form.' }, 502);
  }
}

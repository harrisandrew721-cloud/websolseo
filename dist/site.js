const toggle = document.querySelector('.menu-toggle');
const nav = document.getElementById('navigation');
const dropdowns = [...document.querySelectorAll('.nav-dropdown')];

function closeNavigation() {
  dropdowns.forEach(item => { item.open = false; });
  toggle?.setAttribute('aria-expanded', 'false');
  nav?.classList.remove('open');
}

toggle?.addEventListener('click', () => {
  const open = toggle.getAttribute('aria-expanded') !== 'true';
  if (!open) closeNavigation();
  else {
    toggle.setAttribute('aria-expanded', 'true');
    nav?.classList.add('open');
  }
});
dropdowns.forEach(item => item.addEventListener('toggle', () => {
  if (item.open) dropdowns.forEach(other => { if (other !== item) other.open = false; });
}));
document.addEventListener('click', event => {
  if (!event.target.closest('header')) closeNavigation();
});
nav?.addEventListener('click', event => {
  if (event.target.closest('a')) closeNavigation();
});
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  const openDropdown = dropdowns.find(item => item.open);
  if (openDropdown) {
    openDropdown.open = false;
    openDropdown.querySelector('summary')?.focus();
  } else if (nav?.classList.contains('open')) {
    closeNavigation();
    toggle?.focus();
  }
});

const tabs = [...document.querySelectorAll('.service-option')];
function selectTab(index) {
  tabs.forEach((button, i) => {
    const active = i === index;
    button.setAttribute('aria-selected', String(active));
    button.tabIndex = active ? 0 : -1;
    const panel = document.getElementById(button.getAttribute('aria-controls'));
    if (panel) panel.hidden = !active;
  });
}

const portfolioFilters = [...document.querySelectorAll('.portfolio-filter')];
const portfolioCards = [...document.querySelectorAll('.portfolio-card[data-category]')];
portfolioFilters.forEach(filter => filter.addEventListener('click', () => {
  const value = filter.dataset.filter;
  portfolioFilters.forEach(item => {
    const active = item === filter;
    item.classList.toggle('is-active', active);
    item.setAttribute('aria-pressed', String(active));
  });
  portfolioCards.forEach(card => {
    card.hidden = value !== 'all' && card.dataset.category !== value;
  });
}));
tabs.forEach((button, index) => {
  button.addEventListener('click', () => selectTab(index));
  button.addEventListener('keydown', event => {
    let next;
    if (['ArrowRight', 'ArrowDown'].includes(event.key)) next = (index + 1) % tabs.length;
    if (['ArrowLeft', 'ArrowUp'].includes(event.key)) next = (index - 1 + tabs.length) % tabs.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = tabs.length - 1;
    if (next === undefined) return;
    event.preventDefault();
    selectTab(next);
    tabs[next].focus();
  });
});

const form = document.getElementById('enquiry-form');
if (form) {
  const submit = form.querySelector('button[type="submit"]');
  const note = document.getElementById('form-note');
  const status = document.getElementById('form-status');
  const verification = document.getElementById('enquiry-verification');
  let directSend = false;
  let widgetId;
  let token = '';
  let requestId;
  let sending = false;
  form.addEventListener('input', () => { requestId = undefined; });
  function announce(message) {
    status.textContent = message;
    status.focus();
  }
  function prepareEmail(data) {
    const subject = `${data.service} enquiry — ${data.business}`.replace(/[\r\n]/g, ' ');
    const body = `Name: ${data.name}\nBusiness: ${data.business}\nEmail: ${data.email}\nService: ${data.service}\nWebsite: ${data.website || 'Not provided'}\n\n${data.message}`;
    location.href = `mailto:ryan@websolutionsydney.com.au?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    announce('Please review and send the draft in your email app. This website has not sent your enquiry. If the app did not open, email ryan@websolutionsydney.com.au.');
  }
  async function initialiseDelivery() {
    try {
      const response = await fetch('/api/enquiry', { headers: { Accept: 'application/json' }, cache: 'no-store', signal: AbortSignal.timeout(5000) });
      if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) return;
      const config = await response.json();
      if (!config.enabled || typeof config.siteKey !== 'string' || !config.siteKey) return;
      const script = document.createElement('script');
      script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      script.async = true;
      script.addEventListener('load', () => {
        if (!window.turnstile) return;
        verification.hidden = false;
        widgetId = window.turnstile.render(verification, {
          sitekey: config.siteKey,
          action: 'enquiry',
          callback: value => { token = value; },
          'expired-callback': () => { token = ''; },
          'error-callback': () => { token = ''; }
        });
        directSend = true;
        submit.textContent = 'Send enquiry';
        note.textContent = 'Your enquiry will be sent to our business inbox after the security check. Please do not include passwords or payment details.';
      });
      document.head.append(script);
    } catch {
      // Static hosting retains the explicit email-draft option.
    }
  }
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (sending || !form.reportValidity()) return;
    const data = Object.fromEntries(new FormData(form));
    if (data.company_url) return;
    if (!directSend) { prepareEmail(data); return; }
    if (!token) { announce('Please complete the security check before sending.'); return; }
    requestId ||= crypto.randomUUID();
    sending = true;
    submit.disabled = true;
    submit.textContent = 'Sending…';
    try {
      const response = await fetch('/api/enquiry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ ...data, token, requestId }),
        signal: AbortSignal.timeout(25000)
      });
      const result = await response.json();
      if (!response.ok || result.status !== 'accepted') {
        announce(typeof result.message === 'string' ? result.message : 'We could not confirm your enquiry. Please email or call us before trying again.');
        return;
      }
      announce('Your enquiry was accepted by our email service for delivery. Thank you — we will review your message and respond.');
      form.reset();
      requestId = undefined;
    } catch {
      announce('We could not confirm your enquiry. Please email or call us before trying again. Your details are still in the form.');
    } finally {
      sending = false;
      submit.disabled = false;
      submit.textContent = 'Send enquiry';
      token = '';
      if (widgetId !== undefined) window.turnstile?.reset(widgetId);
    }
  });
  initialiseDelivery();
}

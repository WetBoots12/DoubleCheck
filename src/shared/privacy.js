// Which pages must never be scanned.
//
// This is a privacy control, so it favours blocking a legitimate site now and
// then over scanning a private one once. Precedence, highest first:
//   1. the user's "never scan" list, which always wins;
//   2. the user's "always scan" list, which overrides everything built in;
//   3. the built-in rules: local addresses, a curated list of known sensitive
//      domains, hostname keywords, and path segments.
// Nothing here runs a network request; it is pure string logic, so every case
// is unit-tested.

// Known sensitive domains, matched as suffixes so secure.chase.com is covered.
// Necessarily incomplete: the keyword rules and the page's own signals (a
// password or card field, checked by the content script) carry the long tail.
export const BUILTIN_DOMAINS = [
  // banks, brokerages, payments
  'chase.com', 'bankofamerica.com', 'wellsfargo.com', 'citi.com', 'citibank.com',
  'capitalone.com', 'usbank.com', 'pnc.com', 'truist.com', 'tdbank.com', 'td.com',
  'ally.com', 'discover.com', 'americanexpress.com', 'schwab.com', 'fidelity.com',
  'vanguard.com', 'robinhood.com', 'coinbase.com', 'paypal.com', 'venmo.com',
  'cash.app', 'sofi.com', 'chime.com', 'barclays.co.uk', 'hsbc.com', 'lloydsbank.com',
  'natwest.com', 'santander.com', 'rbc.com', 'scotiabank.com', 'bmo.com', 'cibc.com',
  'zellepay.com', 'wise.com', 'revolut.com', 'monzo.com',
  // health
  'mychart.com', 'kaiserpermanente.org', 'cvs.com', 'walgreens.com', 'goodrx.com',
  'zocdoc.com', 'healthcare.gov', 'medicare.gov', 'va.gov', 'nhs.uk', 'patient.info',
  // government accounts, identity, tax
  'irs.gov', 'ssa.gov', 'login.gov', 'id.me', 'usa.gov', 'gov.uk',
  'turbotax.intuit.com', 'hrblock.com', 'taxact.com',
  // mail, messaging
  'mail.google.com', 'outlook.live.com', 'outlook.office.com', 'outlook.office365.com',
  'mail.yahoo.com', 'proton.me', 'protonmail.com', 'web.whatsapp.com', 'web.telegram.org',
  'messenger.com', 'slack.com', 'teams.microsoft.com', 'discord.com', 'signal.org',
  // password managers, cloud documents, personal storage
  'lastpass.com', '1password.com', 'bitwarden.com', 'dashlane.com',
  'docs.google.com', 'drive.google.com', 'onedrive.live.com', 'dropbox.com',
  'icloud.com', 'box.com',
  // HR, payroll
  'adp.com', 'workday.com', 'paychex.com', 'gusto.com', 'bamboohr.com',
];

// Hostname labels that mark a private service. Matched as whole labels, split on
// dots and hyphens, never as substrings: mail.google.com is caught, dailymail.co.uk
// is not; online-banking.example.com is caught, bankrate.com is not.
export const HOST_KEYWORDS = new Set([
  'bank', 'banking', 'creditunion', 'credit', 'loan', 'loans', 'mortgage', 'lending',
  'invest', 'investing', 'investments', 'brokerage', 'trading', 'wallet',
  'pay', 'payment', 'payments', 'billing', 'checkout', 'cart',
  'health', 'healthcare', 'medical', 'patient', 'patients', 'clinic', 'hospital',
  'pharmacy', 'rx', 'mychart', 'insurance', 'insure', 'benefits',
  'payroll', 'hr', 'tax', 'taxes',
  'login', 'signin', 'sso', 'auth', 'account', 'accounts', 'my', 'portal', 'secure',
  'id', 'identity', 'vault', 'admin', 'intranet', 'dashboard',
  'mail', 'webmail', 'email', 'messages', 'messenger', 'chat',
]);

// URL path segments, matched as whole segments only. A news slug such as
// /account-of-the-battle must not be caught, so there is no hyphen splitting here.
export const PATH_KEYWORDS = new Set([
  'account', 'accounts', 'login', 'signin', 'sign-in', 'logout', 'auth', 'oauth',
  'checkout', 'cart', 'basket', 'billing', 'payment', 'payments', 'pay', 'wallet',
  'portal', 'dashboard', 'settings', 'preferences', 'profile', 'inbox', 'messages',
  'mail', 'chat', 'patient', 'records', 'statements', 'transactions', 'transfer',
  'admin', 'orders', 'order', 'my', 'me', 'user', 'users', 'secure',
]);

export function normalizeDomain(entry) {
  let s = String(entry || '').trim().toLowerCase();
  if (!s || s.startsWith('#')) return '';
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, ''); // scheme
  s = s.split(/[/?#]/)[0];                       // path, query, fragment
  s = s.replace(/:\d+$/, '');                    // port
  s = s.replace(/^www\./, '');
  return /^[a-z0-9.-]+$/.test(s) ? s : '';
}

// One domain per line; blank lines and # comments ignored; duplicates removed.
export function parseDomainList(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const d = normalizeDomain(line);
    if (d && !out.includes(d)) out.push(d);
  }
  return out;
}

export function hostMatches(host, domain) {
  if (!host || !domain) return false;
  return host === domain || host.endsWith(`.${domain}`);
}

function isLocalHost(host) {
  if (!host.includes('.')) return true; // single-label intranet names, localhost
  if (/^(127\.|10\.|192\.168\.|0\.0\.0\.0|169\.254\.)/.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  if (host === '[::1]' || host === '::1') return true;
  return /\.(local|internal|lan|home|localdomain|corp|intranet)$/.test(host);
}

// Returns { blocked, reason, domain, rule } where reason is one of
// 'unsupported' | 'user' | 'local' | 'builtin' | null, and rule is the user's own
// standing rule for the host: 'block' | 'allow' | null.
export function evaluateUrl(url, settings = {}) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return { blocked: true, reason: 'unsupported', domain: '', rule: null };
  }
  if (!/^https?:$/.test(u.protocol)) {
    return { blocked: true, reason: 'unsupported', domain: '', rule: null };
  }

  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const blockedList = settings.blockedDomains || [];
  const allowedList = settings.allowedDomains || [];
  const rule = blockedList.some((d) => hostMatches(host, d))
    ? 'block'
    : allowedList.some((d) => hostMatches(host, d)) ? 'allow' : null;

  if (rule === 'block') return { blocked: true, reason: 'user', domain: host, rule };
  if (rule === 'allow') return { blocked: false, reason: null, domain: host, rule };
  if (settings.privateSitesRule === false) return { blocked: false, reason: null, domain: host, rule };

  if (isLocalHost(host)) return { blocked: true, reason: 'local', domain: host, rule };
  if (BUILTIN_DOMAINS.some((d) => hostMatches(host, d))) {
    return { blocked: true, reason: 'builtin', domain: host, rule };
  }
  if (host.split(/[.-]/).some((label) => HOST_KEYWORDS.has(label))) {
    return { blocked: true, reason: 'builtin', domain: host, rule };
  }
  const segments = u.pathname.toLowerCase().split('/').filter(Boolean);
  if (segments.some((s) => PATH_KEYWORDS.has(s))) {
    return { blocked: true, reason: 'builtin', domain: host, rule };
  }
  return { blocked: false, reason: null, domain: host, rule };
}

// Applies a thumbs-up / thumbs-down choice to the two lists. 'allow' and 'block'
// move the domain to that list; repeating the current rule clears it.
export function applySiteRule(settings, domain, action) {
  const d = normalizeDomain(domain);
  const blocked = (settings.blockedDomains || []).filter((x) => x !== d);
  const allowed = (settings.allowedDomains || []).filter((x) => x !== d);
  if (!d) return { blockedDomains: blocked, allowedDomains: allowed };
  const current = (settings.blockedDomains || []).includes(d)
    ? 'block'
    : (settings.allowedDomains || []).includes(d) ? 'allow' : null;
  if (action === 'block' && current !== 'block') blocked.push(d);
  if (action === 'allow' && current !== 'allow') allowed.push(d);
  return { blockedDomains: blocked, allowedDomains: allowed };
}

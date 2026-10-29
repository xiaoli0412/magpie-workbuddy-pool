// The snapshot a plugin page reads.
//
// A plugin page runs in a sandboxed frame with no network and no access to
// magpie's API beyond the permissions its package.json declares, so it cannot
// ask anything live. What it can do is load its own scripts. The pool therefore
// writes what it knows into `page/data.js` as a plain global, and the page
// reads that: same data, no request, and — because nothing but metadata is
// written — no token ever reaches the frame.
import { writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readAuth, accountsOf } from './store.mjs';
import { REGION_LABEL } from './region.mjs';
import { POOL_DIR } from './pools.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DATA_FILE = join(HERE, '..', 'page', 'data.js');
export const MARK = 'workbuddy-pool';

// What the last import did, so the page can say so without asking anything.
function readLastImport() {
  try {
    return JSON.parse(readFileSync(join(POOL_DIR, 'last-import.json'), 'utf8'));
  } catch {
    return null;
  }
}

// mask keeps an account recognisable without printing a whole number.
export function mask(value) {
  const s = String(value ?? '').trim();
  const digits = s.replace(/\D/g, '');
  if (!digits) return s || '—';
  if (digits.length >= 11) return `${digits.slice(0, 3)}****${digits.slice(-4)}`;
  if (digits.length >= 8) return `${digits.slice(0, 3)}****${digits.slice(-1)}`;
  return `${digits.slice(0, 2)}***`;
}

function hoursLeft(ms) {
  if (!ms) return null;
  return Math.round((ms - Date.now()) / 36e5);
}

// collect is the snapshot body: every account this pool manages, with the live
// metadata from the store and no secrets.
export function collect({ authFile, state, usage, routing, days, now = Date.now() }) {
  const managed = state?.accounts ?? {};
  const lastImport = readLastImport();

  // usage is keyed by what magpie called the account, which is accountId now
  // and used to be the pretty label; the masked number is what both share.
  const usageByAccount = usage?.accounts ?? {};
  const tail = (s) => String(s ?? '').split('·').pop().trim();
  const usageFor = (accountId, label) => {
    if (usageByAccount[accountId]) return usageByAccount[accountId];
    if (usageByAccount[label]) return usageByAccount[label];
    const want = tail(label) || tail(accountId);
    if (!want) return null;
    for (const [k, v] of Object.entries(usageByAccount)) {
      if (tail(k) === want) return v;
    }
    return null;
  };
  let store = {};
  try {
    store = readAuth(authFile).store;
  } catch {
    store = {};
  }

  const accounts = [];
  for (const [key, meta] of Object.entries(managed)) {
    const entry = store[key]?.auth ?? store[key];
    const region = meta.region ?? 'unknown';
    accounts.push({
      key,
      provider: meta.provider,
      region,
      regionLabel: REGION_LABEL[region] ?? REGION_LABEL.unknown,
      label: meta.label,
      accountId: meta.accountId ?? entry?.accountId ?? '',
      uid: meta.uid,
      phone: mask(meta.phone),
      domain: entry?.domain ?? meta.domain ?? '',
      origin: meta.origin ?? '',
      sourceFile: meta.sourceFile ?? '',
      present: Boolean(entry?.access),
      expiresAt: entry?.expires ?? meta.expires ?? 0,
      refreshExpiresAt: entry?.refreshExpiresAt ?? meta.refreshExpiresAt ?? 0,
      hoursLeft: hoursLeft(entry?.expires ?? meta.expires ?? 0),
      enterprise: Boolean(entry?.enterpriseId),
      importedAt: meta.importedAt ?? 0,
      refreshedAt: meta.refreshedAt ?? 0,
      checkedAt: meta.checkedAt ?? 0,
      health: meta.health ?? 'unchecked',
      healthNote: meta.healthNote ?? '',
      healthModel: meta.healthModel ?? '',
      healthMs: meta.healthMs ?? 0,
      lastError: meta.lastError ?? '',
      use: usageFor(meta.accountId ?? '', meta.label ?? ''),
    });
  }

  accounts.sort(
    (a, b) =>
      ['cn', 'hmt', 'intl', 'unknown'].indexOf(a.region) - ['cn', 'hmt', 'intl', 'unknown'].indexOf(b.region) ||
      String(a.label).localeCompare(String(b.label)),
  );

  const counts = { cn: 0, hmt: 0, intl: 0, unknown: 0 };
  for (const a of accounts) counts[a.region] = (counts[a.region] ?? 0) + 1;

  return {
    generatedAt: new Date(now).toISOString(),
    counts: { ...counts, total: accounts.length },
    providers: {
      workbuddy: accounts.filter((a) => a.provider === 'workbuddy').length,
      'workbuddy-ai': accounts.filter((a) => a.provider === 'workbuddy-ai').length,
    },
    health: {
      ok: accounts.filter((a) => a.health === 'ok').length,
      bad: accounts.filter((a) => a.health === 'bad' || a.health === 'missing').length,
      unchecked: accounts.filter((a) => a.health === 'unchecked' || a.health === 'error').length,
    },
    usage: usage ?? null,
    routing: Array.isArray(routing) ? routing : [],
    days: Array.isArray(days) ? days : [],
    lastImport,
    accounts,
  };
}

// writeSnapshot puts the snapshot where the page loads it from.
export function writeSnapshot(snapshot, file = DATA_FILE) {
  const body = `/* generated by magpie-workbuddy-pool — metadata only, no tokens */\nglobalThis.WB_POOL = ${JSON.stringify(snapshot, null, 1)};\n`;
  writeFileSync(file, body, 'utf8');
  return file;
}

export function readSnapshot(file = DATA_FILE) {
  try {
    const text = readFileSync(file, 'utf8');
    const m = text.match(/globalThis\.WB_POOL\s*=\s*([\s\S]*?);\s*$/);
    return m ? JSON.parse(m[1]) : null;
  } catch {
    return null;
  }
}

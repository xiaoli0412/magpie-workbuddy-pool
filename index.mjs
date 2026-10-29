// magpie-workbuddy-pool — keeps an imported WorkBuddy/CodeBuddy pool alive.
//
// Two rules shape this file:
//
//   1. It must not slow magpie down. magpie awaits every plugin's function
//      before it serves a request, so anything that touches the network is
//      pushed to the background and this returns at once. Only local file work
//      happens on the way in.
//   2. It owns nothing but its own rows. The accounts it writes are magpie's
//      own native sign-ins (workbuddy / workbuddy-ai), so no provider is
//      declared here and nothing can collide with another plugin.
//
// What the background work does:
//   - prove each account can actually answer, by asking a model (not by
//     inspecting a token), and remember the verdict;
//   - renew what is close to expiring;
//   - rewrite page/data.js with accounts, health, usage and routing.
import { join } from 'node:path';
import { readFileSync, writeFileSync, unlinkSync, existsSync, statSync } from 'node:fs';
import { POOL_DIR, STATE_FILE, AUTH_FILE } from './lib/pools.mjs';
import { readAuth, writeAuth, readJsonFile, atomicJson } from './lib/store.mjs';
import { renew } from './lib/wb.mjs';
import { ask } from './lib/health.mjs';
import { collect, writeSnapshot, MARK } from './lib/snapshot.mjs';
import { importRecords, recordsFromText, recordsFromFile, sweepHealth } from './lib/importer.mjs';
import { pendingOf, clearPending, isStage } from './lib/options.mjs';
import { readUsage, summarise, routingOf, byDay } from './lib/usage.mjs';

const LOCK = join(POOL_DIR, '.work.lock');
const THROTTLE = join(POOL_DIR, '.work.json');

// Renew a day before the token ends: WorkBuddy hands out a month.
const RENEW_WITHIN_MS = 36 * 36e5;
const RENEW_EVERY_MS = 6 * 36e5;
// A model-level check costs one request per account, so it is worth hours, not
// minutes. A token that is plainly dead is never asked.
const HEALTH_EVERY_MS = 3 * 36e5;
const LOCK_STALE_MS = 5 * 60e3;

const log = (...a) => console.log('[workbuddy-pool]', ...a);

function takeLock() {
  try {
    if (existsSync(LOCK) && Date.now() - statSync(LOCK).mtimeMs < LOCK_STALE_MS) return false;
    writeFileSync(LOCK, String(process.pid), 'utf8');
    return true;
  } catch {
    return false;
  }
}

function dropLock() {
  try {
    unlinkSync(LOCK);
  } catch {}
}

export function stateNow() {
  const s = readJsonFile(STATE_FILE, { accounts: {} });
  s.accounts ??= {};
  return s;
}

// applyPending takes an import the page left in this plugin's own options and
// writes it. It is the one thing that happens before the plugin answers: the
// user is waiting for it, and it is a file write, not a model call.
async function applyPending() {
  const stage = pendingOf();
  if (!isStage(stage)) return null;

  const fromFile = typeof stage.path === 'string' && stage.path.trim();
  const { records, error } = fromFile
    ? recordsFromFile(stage.path, stage.name || '')
    : recordsFromText(stage.text);

  if (error) {
    log(`import refused: ${error}`);
    atomicJson(join(POOL_DIR, 'last-import.json'), { at: Date.now(), error, name: stage.name ?? '' });
    clearPending();
    return { error };
  }
  const report = await importRecords({ records, fileName: stage.name || '', authFile: AUTH_FILE, stateFile: STATE_FILE });
  clearPending();
  const summary = {
    at: Date.now(),
    name: stage.name ?? '',
    imported: report.planned.length,
    dropped: report.dropped.length,
    accounts: report.planned.map((p) => ({ key: p.key, label: p.label, region: p.region })),
  };
  atomicJson(join(POOL_DIR, 'last-import.json'), summary);
  log(`imported ${summary.imported} account(s) from ${stage.name || 'text'}`);
  return summary;
}

// healthOnce asks every live account's model to answer, one at a time in small
// groups so a pool of fifty does not open fifty streams at once.
async function healthOnce(state, concurrency = 3) {
  const managed = state.accounts;
  const { store } = readAuth(AUTH_FILE);
  const keys = Object.keys(managed);
  const now = Date.now();
  let asked = 0;
  let alive = 0;
  let cursor = 0;

  const worker = async () => {
    while (cursor < keys.length) {
      const key = keys[cursor++];
      const meta = managed[key];
      const entry = store[key]?.auth ?? store[key];
      if (!entry?.access) {
        meta.health = 'missing';
        meta.healthNote = '登录态缺失';
        meta.checkedAt = now;
        continue;
      }
      // an expired token has nothing to prove; asking would only cost a round trip
      if (entry.expires && entry.expires <= now) {
        meta.health = 'bad';
        meta.healthNote = 'access token 已过期';
        meta.checkedAt = now;
        continue;
      }
      asked++;
      const r = await ask(meta.provider, entry);
      meta.health = r.ok ? 'ok' : 'bad';
      meta.healthNote = r.ok ? '' : r.error;
      meta.healthModel = r.model;
      meta.healthMs = r.ms;
      meta.checkedAt = Date.now();
      if (r.ok) alive++;
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, keys.length || 1) }, worker));
  atomicJson(STATE_FILE, state);
  log(`asked ${asked} account(s), ${alive} answered`);
  return { asked, alive };
}

// renewOnce spends the refresh token of anything close to ending.
async function renewOnce(state) {
  const managed = state.accounts;
  let data;
  let store;
  try {
    ({ data, store } = readAuth(AUTH_FILE));
  } catch {
    return { renewed: 0, failed: 0 };
  }

  let renewed = 0;
  let failed = 0;
  for (const [key, meta] of Object.entries(managed)) {
    const entry = store[key]?.auth ?? store[key];
    if (!entry?.access) continue;
    if (entry.method !== MARK && entry.pool !== MARK) continue; // never another plugin's row
    const expires = Number(entry.expires) || 0;
    if (expires && expires - Date.now() > RENEW_WITHIN_MS) continue;
    const refreshExpires = Number(entry.refreshExpiresAt) || 0;
    if (!entry.refresh || (refreshExpires && Date.now() >= refreshExpires)) {
      meta.lastError = 'refresh token 已失效，请重新导入';
      continue;
    }
    try {
      const next = await renew(meta.provider, entry);
      const now = readAuth(AUTH_FILE);
      const current = now.store[key]?.auth ?? now.store[key];
      if (!current) continue;
      Object.assign(current, {
        access: next.access,
        refresh: next.refresh,
        expires: next.expires,
        refreshExpiresAt: next.refreshExpiresAt,
        domain: next.domain || current.domain,
        tokenType: next.tokenType || current.tokenType,
      });
      now.store[key] = now.store[key]?.auth ? { ...now.store[key], auth: current } : current;
      writeAuth(AUTH_FILE, now.data);
      meta.refreshedAt = Date.now();
      meta.expires = next.expires;
      meta.refreshExpiresAt = next.refreshExpiresAt;
      meta.lastError = '';
      renewed++;
    } catch (e) {
      failed++;
      meta.lastError = String(e?.message ?? e).slice(0, 160);
    }
  }
  if (renewed || failed) {
    atomicJson(STATE_FILE, state);
    log(`renewed ${renewed}, ${failed} failed`);
  }
  return { renewed, failed };
}

// background does the network work. Nothing waits for it.
async function background() {
  if (!takeLock()) return;
  try {
    const state = stateNow();
    const last = readJsonFile(THROTTLE, {});
    const now = Date.now();

    if (!last.healthAt || now - last.healthAt > HEALTH_EVERY_MS) {
      try {
        const r = await healthOnce(state);
        last.healthAt = now;
        last.healthAsked = r.asked;
        last.healthAlive = r.alive;
      } catch (e) {
        log(`health: ${e?.message ?? e}`);
      }
    }

    if (!last.renewAt || now - last.renewAt > RENEW_EVERY_MS) {
      try {
        const r = await renewOnce(stateNow());
        last.renewAt = now;
        last.renewed = r.renewed;
      } catch (e) {
        log(`renew: ${e?.message ?? e}`);
      }
    }

    atomicJson(THROTTLE, last);
  } finally {
    dropLock();
  }

  // the page's numbers come from local files, so they are refreshed after the
  // network work rather than before it
  try {
    writeSnapshot(snapshot());
  } catch (e) {
    log(`snapshot: ${e?.message ?? e}`);
  }
}

// snapshot is everything the page shows, built from local files only.
export function snapshot() {
  const state = stateNow();
  let records = [];
  try {
    records = readUsage({ days: 30 });
  } catch {
    records = [];
  }
  const summary = summarise(records);
  return collect({
    authFile: AUTH_FILE,
    state,
    usage: { total: summary.total, accounts: summary.accounts, models: summary.models },
    routing: routingOf(summary),
    days: byDay(records, 14),
  });
}

// workbuddyPool is magpie's entry point: async (input, options) => hooks.
// It returns no hooks at all — the accounts are already the provider's.
export const workbuddyPool = async (input, options) => {
  // 1. work the page left for us, which is a file write and must land now
  try {
    await applyPending();
  } catch (e) {
    log(`import: ${e?.message ?? e}`);
  }

  // 2. the page's data from local files: fast, and always current on open
  try {
    writeSnapshot(snapshot());
  } catch (e) {
    log(`snapshot: ${e?.message ?? e}`);
  }

  // 3. anything that talks to WorkBuddy happens after this returns
  setTimeout(() => {
    background().catch((e) => log(`background: ${e?.message ?? e}`));
  }, 0).unref?.();

  return {};
};

export default workbuddyPool;

// For the CLI and the tests; magpie never calls these.
export const _internal = { applyPending, healthOnce, renewOnce, snapshot, RENEW_WITHIN_MS, HEALTH_EVERY_MS };

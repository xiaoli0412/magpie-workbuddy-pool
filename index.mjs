// magpie-workbuddy-pool — keeps an imported WorkBuddy/CodeBuddy pool alive.
//
// The accounts are written by `tools/import.mjs`, by the page's import button,
// or by `tools/watch.mjs`, into magpie's own sign-in store, under the same keys
// magpie would use for a provider's second and later account:
//
//   workbuddy       the China build   (copilot.tencent.com)  ← 大陆 + 港澳台
//   workbuddy-ai    the international build (www.workbuddy.ai)
//
// Nothing here re-declares those providers on purpose: the pool lands as native
// accounts of the providers the community WorkBuddy plugin already signed in
// to, so magpie shows one WorkBuddy with many accounts, and any other plugin
// reading the same store — the 成长计划 / 任务签到 one among them — sees the very
// same rows. That is also why this plugin declares no provider and no tool, and
// therefore cannot collide with any other plugin's.
//
// What it does when loaded:
//   1. takes an import the page left in this plugin's options, and applies it;
//   2. checks which accounts are actually alive (throttled);
//   3. renews the ones close to their end (throttled);
//   4. rewrites page/data.js, the snapshot the page reads.
import { join } from 'node:path';
import { POOL_DIR, STATE_FILE, AUTH_FILE, loadPools } from './lib/pools.mjs';
import { readAuth, writeAuth, readJsonFile, atomicJson } from './lib/store.mjs';
import { renew } from './lib/wb.mjs';
import { collect, writeSnapshot, MARK } from './lib/snapshot.mjs';
import { importRecords, recordsFromText, recordsFromFile, sweepHealth } from './lib/importer.mjs';
import { pendingOf, clearPending, isStage } from './lib/options.mjs';

const LOCK = join(POOL_DIR, '.work.lock');
const THROTTLE = join(POOL_DIR, '.work.json');

// An access token is renewed a day before it ends: WorkBuddy hands out a month,
// so a pool refreshed daily never lapses.
const RENEW_WITHIN_MS = 36 * 36e5;
// A health sweep is worth doing every few hours, not on every load.
const HEALTH_EVERY_MS = 3 * 36e5;
// WorkBuddy answers a probe in a second; past this the network is down, not slow.
const LOCK_STALE_MS = 5 * 60e3;

const log = (...a) => console.log('[workbuddy-pool]', ...a);

function takeLock() {
  const { existsSync, writeFileSync, statSync } = require_fs();
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
    require_fs().unlinkSync(LOCK);
  } catch {}
}

// node:fs is loaded once, lazily, so the module stays readable at the top.
let fs = null;
function require_fs() {
  if (!fs) throw new Error('fs not loaded');
  return fs;
}

function state() {
  const s = readJsonFile(STATE_FILE, { accounts: {} });
  s.accounts ??= {};
  return s;
}

// applyPending takes the page's submission out of this plugin's options and
// imports it. It is idempotent: the option is cleared only once the write is
// done, so a crash leaves the work for the next load rather than losing it.
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

  const report = await importRecords({
    records,
    fileName: stage.name || '',
    authFile: AUTH_FILE,
    stateFile: STATE_FILE,
  });
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

// sweepHealthOnce checks every managed account and records the verdict.
async function healthOnce() {
  return sweepHealth({ stateFile: STATE_FILE, authFile: AUTH_FILE });
}

// sweepRenew renews what is about to lapse. Each account is independent: one
// refusal is recorded on that account and never stops the others.
async function renewOnce() {
  const s = state();
  const managed = s.accounts;
  if (!Object.keys(managed).length) return { renewed: 0, failed: 0 };

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
    if (entry.method !== MARK && entry.pool !== MARK) continue; // never another plugin's

    const expires = Number(entry.expires) || 0;
    if (expires && expires - Date.now() > RENEW_WITHIN_MS) continue;
    const refreshExpires = Number(entry.refreshExpiresAt) || 0;
    if (!entry.refresh || (refreshExpires && Date.now() >= refreshExpires)) {
      meta.lastError = 'refresh token 已失效，请重新导入';
      continue;
    }

    try {
      const next = await renew(meta.provider, entry);
      // Re-read right before writing: magpie may have signed in meanwhile.
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
    atomicJson(STATE_FILE, s);
    log(`renewed ${renewed}, ${failed} failed`);
  }
  return { renewed, failed };
}

// workbuddyPool is magpie's entry point: `async (input, options) => hooks`.
// It returns no hooks at all — the accounts are already the provider's.
export const workbuddyPool = async (input, options) => {
  const { readFileSync, writeFileSync, unlinkSync, existsSync, statSync } = await import('node:fs');
  fs = { readFileSync, writeFileSync, unlinkSync, existsSync, statSync };

  // 1. work the page left for us — done first, before anything is measured
  try {
    await applyPending();
  } catch (e) {
    log(`import: ${e?.message ?? e}`);
  }

  // 2. the rest is housekeeping, one run at a time
  if (takeLock()) {
    try {
      const last = readJsonFile(THROTTLE, {});
      const now = Date.now();

      if (!last.healthAt || now - last.healthAt > HEALTH_EVERY_MS) {
        try {
          const r = await healthOnce();
          last.healthAt = now;
          last.healthChecked = r.checked;
        } catch (e) {
          log(`health: ${e?.message ?? e}`);
        }
      }

      if (!last.renewAt || now - last.renewAt > 6 * 36e5) {
        try {
          await renewOnce();
          last.renewAt = now;
        } catch (e) {
          log(`renew: ${e?.message ?? e}`);
        }
      }

      atomicJson(THROTTLE, last);
    } finally {
      dropLock();
    }
  }

  // 3. the page's data, every load, from what is on disk right now
  try {
    writeSnapshot(collect({ authFile: AUTH_FILE, state: state() }));
  } catch (e) {
    log(`snapshot: ${e?.message ?? e}`);
  }

  return {};
};

export default workbuddyPool;

// For the CLI and the tests; magpie never calls these.
export const _internal = { applyPending, healthOnce, renewOnce, RENEW_WITHIN_MS, HEALTH_EVERY_MS, loadPools };

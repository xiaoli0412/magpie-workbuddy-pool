// The four things a user can ask the pool to do from the page, and the state
// machine behind them.
//
// A plugin page cannot read the store or send a request, so each action arrives
// as a message in the plugin's options and is carried out here, where the files
// and the network are. Everything is written back before the action is cleared,
// so a crash repeats the action instead of losing it.
import { readAuth, writeAuth, readJsonFile, atomicJson } from './store.mjs';
import { AUTH_FILE, STATE_FILE, keyFor } from './pools.mjs';
import { probeAccount } from './health.mjs';
import { applyResult, emptyLife, isUsable, whyNot, DISABLE_AFTER } from './lifecycle.mjs';

const log = (...a) => console.log('[workbuddy-pool]', ...a);

function state(file = STATE_FILE) {
  const s = readJsonFile(file, { accounts: {} });
  s.accounts ??= {};
  s.disabledAuth ??= {};
  return s;
}

function save(s, file = STATE_FILE) {
  atomicJson(file, s);
}

// lifeOf reads an account's state, filling in defaults for a fresh row.
export function lifeOf(meta) {
  return {
    ...emptyLife(),
    health: meta.health ?? 'unchecked',
    failStreak: meta.failStreak ?? 0,
    okStreak: meta.okStreak ?? 0,
    cooldownUntil: meta.cooldownUntil ?? 0,
    disabled: Boolean(meta.disabled),
    lastTestAt: meta.checkedAt ?? 0,
    lastTestError: meta.healthNote ?? '',
    lastKind: meta.lastKind ?? '',
  };
}

// writeLife puts a life back on the account row, under the names the snapshot
// and the page already use.
function writeLife(meta, life) {
  meta.health = life.health;
  meta.failStreak = life.failStreak;
  meta.okStreak = life.okStreak;
  meta.cooldownUntil = life.cooldownUntil;
  meta.disabled = life.disabled;
  meta.checkedAt = life.lastTestAt;
  meta.healthNote = life.lastTestError;
  meta.lastKind = life.lastKind;
}

// takeOut removes a disabled account from magpie's sign-in store, keeping its
// credential aside so it can be put back without the original file.
function takeOut(s, key) {
  let data;
  let store;
  try {
    ({ data, store } = readAuth(AUTH_FILE));
  } catch {
    return false;
  }
  if (!store[key]) return false;
  s.disabledAuth[key] = store[key];
  delete store[key];
  writeAuth(AUTH_FILE, data);
  return true;
}

// putBack restores an account that was taken out.
function putBack(s, key) {
  const saved = s.disabledAuth?.[key];
  if (!saved) return false;
  let data;
  let store;
  try {
    ({ data, store } = readAuth(AUTH_FILE));
  } catch {
    return false;
  }
  store[key] = saved;
  delete s.disabledAuth[key];
  writeAuth(AUTH_FILE, data);
  return true;
}

// testAccounts asks the given accounts to answer, applies the result to their
// state, and takes out the ones that have now failed too often.
//
//   uids  a list of uids, or 'all'
export async function testAccounts(uids = 'all', { models = 4, concurrency = 3 } = {}) {
  const s = state();
  const { store } = readAuth(AUTH_FILE);
  const keys = Object.keys(s.accounts).filter((k) => uids === 'all' || uids.includes(s.accounts[k].uid));
  const now = Date.now();
  let tested = 0;
  let ok = 0;
  let disabled = 0;
  let cursor = 0;

  const worker = async () => {
    while (cursor < keys.length) {
      const key = keys[cursor++];
      const meta = s.accounts[key];
      const entry = store[key]?.auth ?? store[key];
      if (!entry?.access) {
        writeLife(meta, applyResult(lifeOf(meta), { ok: false, error: '登录态缺失' }, now));
        continue;
      }
      if (entry.expires && entry.expires <= now) {
        writeLife(meta, applyResult(lifeOf(meta), { ok: false, error: 'access token 已过期' }, now));
        continue;
      }
      const auth = { access: entry.access, uid: meta.uid, domain: entry.domain, refresh: entry.refresh };
      const r = await probeAccount(meta.provider, auth, { models });
      const life = applyResult(lifeOf(meta), { ok: r.ok, error: r.error, status: r.tested?.find((t) => !t.ok)?.status }, now);
      writeLife(meta, life);
      meta.healthModel = r.tested?.find((t) => t.ok)?.model ?? r.tested?.[0]?.model ?? '';
      meta.healthMs = r.ms ?? 0;
      meta.aliveModels = (r.tested ?? []).filter((t) => t.ok).map((t) => t.model);
      meta.testedModels = (r.tested ?? []).map((t) => ({ model: t.model, ok: t.ok, ms: t.ms, error: t.error }));
      tested++;
      if (r.ok) ok++;
      if (life.disabled && takeOut(s, key)) disabled++;
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, keys.length || 1) }, worker));
  save(s);
  log(`tested ${tested}: ${ok} answered, ${disabled} disabled`);
  return { tested, ok, disabled, total: keys.length };
}

// removeAccounts deletes them from both the store and the state, so a removed
// account really stops being part of the pool.
export function removeAccounts(uids) {
  const s = state();
  let data;
  let store;
  try {
    ({ data, store } = readAuth(AUTH_FILE));
  } catch {
    return { removed: 0 };
  }
  let removed = 0;
  for (const key of Object.keys(s.accounts)) {
    if (!uids.includes(s.accounts[key].uid)) continue;
    delete store[key];
    delete s.accounts[key];
    delete s.disabledAuth?.[key];
    removed++;
  }
  if (removed) {
    writeAuth(AUTH_FILE, data);
    save(s);
  }
  log(`removed ${removed} account(s)`);
  return { removed };
}

// setEnabled switches accounts on or off by hand. Off takes the row out of the
// sign-in store (so magpie stops using it) and keeps the credential aside.
export function setEnabled(uids, on) {
  const s = state();
  let changed = 0;
  for (const key of Object.keys(s.accounts)) {
    const meta = s.accounts[key];
    if (!uids.includes(meta.uid)) continue;
    const life = lifeOf(meta);
    if (on) {
      putBack(s, key);
      writeLife(meta, { ...life, disabled: false, health: 'unchecked', failStreak: 0, cooldownUntil: 0, lastTestError: '' });
    } else {
      takeOut(s, key);
      writeLife(meta, { ...life, disabled: true, health: 'disabled', lastTestError: '手动关闭' });
    }
    changed++;
  }
  if (changed) save(s);
  log(`${on ? 'enabled' : 'disabled'} ${changed} account(s)`);
  return { changed };
}

// runAction is the entry point for whatever the page sent.
export async function runAction(action) {
  const type = String(action?.type ?? '');
  const uids = action?.uids === 'all' ? 'all' : Array.isArray(action?.uids) ? action.uids : 'all';
  switch (type) {
    case 'test':
      return testAccounts(uids, { models: Number(action.models) || 4 });
    case 'delete':
      return uids === 'all' ? { removed: 0 } : removeAccounts(uids);
    case 'enable':
      return uids === 'all' ? { changed: 0 } : setEnabled(uids, true);
    case 'disable':
      return uids === 'all' ? { changed: 0 } : setEnabled(uids, false);
    default:
      return { ignored: type };
  }
}

export { isUsable, whyNot, DISABLE_AFTER };

// The one importer, shared by the command line and by the plugin.
//
// `tools/import.mjs`, the page's import button and the health sweep must all
// do exactly the same thing, so the work lives here once: read a pool, place
// each account in a region, write it into magpie's own sign-in store under the
// native provider, and report what happened.
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { keyFor, normalise } from './pools.mjs';
import { classify, providerFor, REGION_LABEL } from './region.mjs';
import { readAuth, writeAuth, readJsonFile } from './store.mjs';
import { probe } from './wb.mjs';
import { mask, MARK } from './snapshot.mjs';

const ASCII = { cn: 'CN', hmt: 'HMT', intl: 'INTL', unknown: 'UNK' };

// How close to the end of a refresh token is worth a warning.
const WARN_REFRESH_MS = 3 * 864e5;

function writeJson(file, value) {
  writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2), 'utf8');
  renameSync(`${file}.tmp`, file);
}

// recordsFromText accepts the three shapes an export comes in — an array, a
// { accounts } wrapper, a bare object — and returns normalised records.
export function recordsFromText(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return { records: [], error: `不是 JSON：${e.message}` };
  }
  const list = Array.isArray(data)
    ? data
    : Array.isArray(data.accounts)
      ? data.accounts
      : Array.isArray(data.data)
        ? data.data
        : [data];
  const records = list.map((x) => normalise(x, '')).filter((r) => r);
  return { records, error: records.length ? '' : '没有可用账号（缺 access_token 或 uid）' };
}

export function recordsFromFile(file, sourceName = '') {
  if (!existsSync(file)) return { records: [], error: '文件不存在' };
  const text = readFileSync(file, 'utf8');
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return { records: [], error: `不是 JSON：${e.message}` };
  }
  const list = Array.isArray(data) ? data : Array.isArray(data.accounts) ? data.accounts : Array.isArray(data.data) ? data.data : [data];
  const records = list.map((x) => normalise(x, sourceName || file)).filter((r) => r);
  return { records, error: records.length ? '' : '没有可用账号' };
}

// place decides provider, region and names for one record. A live probe is the
// only evidence that cannot lie about which build issued a token, so it is
// asked first when allowed.
async function place(rec, { fileName, probeLive }) {
  let live = null;
  if (probeLive) {
    for (const candidate of ['workbuddy', 'workbuddy-ai']) {
      try {
        const r = await probe(candidate, { access: rec.access, uid: rec.uid, domain: rec.domain });
        if (r.ok) {
          live = { provider: candidate, ...r };
          break;
        }
      } catch {
        // an unreachable build is not evidence either way
      }
    }
  }

  const cls = classify(rec, { probe: live?.build, fileName });
  const provider = live?.provider ?? providerFor(cls.region);
  const region = provider === 'workbuddy-ai' ? 'intl' : cls.region === 'intl' ? 'cn' : cls.region;

  // Two names on purpose: accountId is what magpie shows and also the key a
  // request pins an account with (X-Magpie-Account), and an HTTP header cannot
  // carry the Chinese the region is called by, so it stays ASCII. An account
  // with no number to mask falls back to its uid. label is the page's wording.
  const tail = mask(rec.phone);
  const ascii = /^[\x20-\x7e]+$/.test(tail) && /\d/.test(tail)
    ? tail
    : String(rec.uid).replace(/[^0-9a-zA-Z]/g, '').slice(-6);
  return {
    key: keyFor(provider, rec.uid),
    provider,
    region,
    accountId: `${ASCII[region] ?? 'UNK'}-${ascii}`,
    label: `${REGION_LABEL[region] ?? REGION_LABEL.unknown} · ${tail}`,
    rec,
    live,
    reasons: cls.reasons,
  };
}

// importRecords is the whole operation. Nothing is written unless `dry` is
// false; the report is what the CLI prints and what the page shows.
export async function importRecords({ records, fileName = '', authFile, stateFile, dry = false, probeLive = true }) {
  const state = readJsonFile(stateFile, { accounts: {} });
  state.accounts ??= {};

  const { data, store } = readAuth(authFile);
  const planned = [];
  const seen = new Set();

  for (const rec of records) {
    const p = await place(rec, { fileName, probeLive });
    p.entry = {
      type: 'oauth',
      access: rec.access,
      refresh: rec.refresh,
      expires: rec.expiresMs,
      accountId: p.accountId,
      uid: rec.uid,
      domain: rec.domain || (p.provider === 'workbuddy-ai' ? 'www.workbuddy.ai' : 'www.codebuddy.cn'),
      tokenType: rec.tokenType || 'Bearer',
      method: MARK,
      pool: MARK,
      region: p.region,
      ...(rec.refreshExpiresMs ? { refreshExpiresAt: rec.refreshExpiresMs } : {}),
      ...(rec.enterpriseId ? { enterpriseId: rec.enterpriseId } : {}),
    };
    planned.push(p);
    seen.add(p.key);

    const previous = state.accounts[p.key] ?? {};
    state.accounts[p.key] = {
      uid: rec.uid,
      provider: p.provider,
      region: p.region,
      label: p.label,
      accountId: p.accountId,
      phone: rec.phone,
      domain: p.entry.domain,
      origin: rec.origin,
      sourceFile: rec.sourceFile || fileName,
      expires: rec.expiresMs,
      refreshExpiresAt: rec.refreshExpiresMs,
      importedAt: previous.importedAt ?? Date.now(),
      refreshedAt: previous.refreshedAt ?? 0,
      checkedAt: p.live?.ok ? Date.now() : previous.checkedAt ?? 0,
      health: p.live?.ok ? 'ok' : (previous.health ?? 'unchecked'),
      healthNote: p.live?.ok ? '' : (previous.healthNote ?? ''),
      lastError: '',
    };
  }

  // Accounts this pool wrote before but no longer finds are dropped — only the
  // ones it wrote; anything magpie or another plugin signed in stays.
  const dropped = [];
  for (const [key, entry] of Object.entries(store)) {
    const value = entry?.auth ?? entry;
    const mine = value?.method === MARK || value?.pool === MARK;
    if (mine && !seen.has(key)) dropped.push(key);
  }

  if (!dry) {
    for (const p of planned) store[p.key] = p.entry;
    for (const key of dropped) {
      delete store[key];
      delete state.accounts[key];
    }
    writeAuth(authFile, data);
    writeJson(stateFile, state);
  }

  return { planned, dropped, state, dry };
}

// sweepHealth asks WorkBuddy about every managed account and records the
// answer, so the page can say which ones are actually alive rather than which
// ones merely look unexpired.
export async function sweepHealth({ stateFile, authFile, only = null, concurrency = 3 }) {
  const state = readJsonFile(stateFile, { accounts: {} });
  const managed = state.accounts ?? {};
  const { store } = readAuth(authFile);

  const keys = Object.keys(managed).filter((k) => !only || only.includes(k));
  const results = [];
  let cursor = 0;

  const worker = async () => {
    while (cursor < keys.length) {
      const key = keys[cursor++];
      const meta = managed[key];
      const auth = store[key]?.auth ?? store[key];
      if (!auth?.access) {
        meta.health = 'missing';
        meta.healthNote = '登录态缺失';
        meta.checkedAt = Date.now();
        results.push({ key, health: 'missing' });
        continue;
      }
      try {
        const r = await probe(meta.provider, auth);
        meta.checkedAt = Date.now();
        if (r.ok) {
          meta.health = 'ok';
          meta.healthNote = r.nickname || r.phone || '';
        } else {
          meta.health = 'bad';
          meta.healthNote = r.reason || `HTTP ${r.status}`;
        }
        results.push({ key, health: meta.health });
      } catch (e) {
        meta.health = 'error';
        meta.healthNote = String(e?.message ?? e).slice(0, 120);
        meta.checkedAt = Date.now();
        results.push({ key, health: 'error' });
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, keys.length || 1) }, worker));
  writeJson(stateFile, state);
  return { checked: results.length, results, state };
}

// healthOf is how an account reads at a glance, from the stored entry alone.
export function healthOf(entry) {
  if (!entry?.access) return { level: 'bad', text: '登录态缺失' };
  const now = Date.now();
  const exp = Number(entry.expires) || 0;
  const refreshExp = Number(entry.refreshExpiresAt) || 0;
  if (exp && exp <= now) return { level: 'bad', text: '已过期' };
  if (refreshExp && refreshExp <= now) return { level: 'bad', text: 'refresh 已过期，需重新导入' };
  if (refreshExp && refreshExp - now < WARN_REFRESH_MS) return { level: 'warn', text: 'refresh 即将过期' };
  if (exp && exp - now < 24 * 36e5) return { level: 'warn', text: 'access 24 小时内过期' };
  return { level: 'ok', text: '正常' };
}

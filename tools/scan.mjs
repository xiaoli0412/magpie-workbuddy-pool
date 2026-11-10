#!/usr/bin/env bun
// Scan every account in a pool folder and prove which ones can actually answer.
//
//   bun tools/scan.mjs [--dir <folder>] [--models 4] [--concurrency 4]
//                      [--limit N] [--force] [--json]
//
// For each account it lists the models the build offers, picks up to N of them
// across different vendors, and sends one tiny streamed chat to each. An account
// is alive when at least one model answers; the report also says which families
// were refused, which is what a bare "token valid" check can never tell you.
//
// Results go to <folder>/scan-result.json and are reused on the next run, so a
// scan of two hundred accounts can be stopped and continued. --force re-tests.
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import { normalise, POOL_DIR } from '../lib/pools.mjs';
import { probeAccount, listModels, askModel, pickModels } from '../lib/health.mjs';
import { renew } from '../lib/wb.mjs';
import { providerFor } from '../lib/region.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : d;
};

const dir = opt('dir', POOL_DIR);
const wantModels = Number(opt('models', 4));
const concurrency = Math.max(1, Number(opt('concurrency', 4)));
const limit = Number(opt('limit', 0));
const force = flag('force');
const asJson = flag('json');
const RESULT = join(dir, 'scan-result.json');

// ---- read the pool -------------------------------------------------------
function loadRecords(folder) {
  const files = readdirSync(folder)
    .filter((n) => extname(n).toLowerCase() === '.json' && !n.startsWith('.') && n !== 'scan-result.json')
    .map((n) => join(folder, n))
    .filter((p) => {
      try {
        return statSync(p).isFile();
      } catch {
        return false;
      }
    });

  const out = [];
  for (const file of files) {
    let data;
    try {
      data = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    const list = Array.isArray(data) ? data : Array.isArray(data.accounts) ? data.accounts : [data];
    for (const item of list) {
      const rec = normalise(item, file);
      if (rec) out.push(rec);
    }
  }
  return out;
}

// ---- resume --------------------------------------------------------------
const previous = existsSync(RESULT) && !force ? JSON.parse(readFileSync(RESULT, 'utf8')) : null;
const done = new Map((previous?.accounts ?? []).map((a) => [a.uid, a]));

const records = loadRecords(dir);
if (!records.length) {
  console.error(`no account found in ${dir}`);
  process.exit(1);
}

const todo = records.filter((r) => {
  if (!done.has(r.uid)) return true;
  // --retry-failed re-tests the accounts a rate limit or a dropped connection
  // touched: those say nothing about the account, and leaving them out would
  // quietly drop good rows from the import.
  if (flag('retry-failed')) {
    const prev = done.get(r.uid);
    if (!prev?.ok && /限流|timed out|ECONNRESET|网络|超时/i.test(String(prev?.error ?? ''))) {
      done.delete(r.uid);
      return true;
    }
  }
  return false;
});
const target = limit > 0 ? todo.slice(0, limit) : todo;

if (!asJson) {
  console.log(`pool: ${dir}`);
  console.log(`accounts: ${records.length}  already scanned: ${records.length - todo.length}  to scan: ${target.length}`);
  console.log(`models per account: ${wantModels}   concurrency: ${concurrency}\n`);
}

// ---- scan ----------------------------------------------------------------
const results = [...(previous?.accounts ?? [])];
let cursor = 0;
let alive = 0;
let dead = 0;

function pickProvider(rec) {
  // realm is the scraper's own word; the domain decides the rest
  const realm = String(rec.origin ?? '').toLowerCase();
  if (realm === 'intl' || /workbuddy\.ai|codebuddy\.ai/.test(rec.domain)) return 'workbuddy-ai';
  return 'workbuddy';
}

// A 429 is a rate limit, not a verdict: the same account answers a second
// later. So a rate-limited answer is retried with a growing wait, and only a
// refusal that survives that is reported as one.
async function askWithRetry(provider, auth, model, { attempts = 3, base = 1500 } = {}) {
  let last;
  for (let i = 0; i < attempts; i++) {
    last = await askModel(provider, auth, model);
    if (last.status !== 429) return last;
    if (i < attempts - 1) await sleep(base * (i + 1));
  }
  return last;
}

// probeWithRecovery lists, then asks each model; a token the build rejects gets
// one refresh and one more try before the account is called dead.
async function probeWithRecovery(provider, rec, wantModels) {
  let auth = { access: rec.access, uid: rec.uid, domain: rec.domain, refresh: rec.refresh };

  let listed = await listModels(provider, auth);
  if (!listed.ok && /HTTP 40[13]|401|403|未完成登录/.test(String(listed.error))) {
    try {
      const next = await renew(provider, auth);
      auth = { ...auth, ...next };
      listed = await listModels(provider, auth);
    } catch {
      /* refresh refused: the account really is signed out */
    }
  }
  if (!listed.ok) return { ok: false, error: listed.error, models: [], tested: [], alive: 0, ms: 0, refreshed: false };

  const chosen = pickModels(listed.models, wantModels);
  const tested = [];
  const started = Date.now();
  for (const model of chosen) tested.push(await askWithRetry(provider, auth, model));

  const alive = tested.filter((r) => r.ok).length;
  const limited = tested.length > 0 && tested.every((r) => r.status === 429);
  return {
    ok: alive > 0,
    // A wholly rate-limited account is unknown, not dead. Saying so keeps a
    // scan from throwing away good accounts because the pool was busy.
    error: alive ? '' : limited ? '限流（并发太高，稍后重试）' : tested[0]?.error ?? '全部模型均无回包',
    models: listed.models,
    tested,
    alive,
    ms: Date.now() - started,
    refreshed: auth.access !== rec.access,
  };
}

async function worker() {
  while (cursor < target.length) {
    const i = cursor++;
    const rec = target[i];
    const provider = pickProvider(rec);
    const expired = rec.expiresMs > 0 && rec.expiresMs <= Date.now();

    let row;
    if (expired) {
      row = { uid: rec.uid, nickname: rec.nickname, phone: rec.phone, file: rec.sourceFile, realm: rec.origin, provider, expired: true, ok: false, alive: 0, tested: [], models: [], ms: 0, error: 'access token 已过期' };
    } else {
      const r = await probeWithRecovery(provider, rec, wantModels);
      row = {
        uid: rec.uid,
        nickname: rec.nickname,
        phone: rec.phone,
        file: rec.sourceFile,
        realm: rec.origin,
        provider,
        expired: false,
        ok: r.ok,
        alive: r.alive ?? 0,
        tested: (r.tested ?? []).map((t) => ({ model: t.model, ok: t.ok, ms: t.ms, error: t.error, status: t.status })),
        models: r.models ?? [],
        ms: r.ms ?? 0,
        error: r.error ?? '',
        refreshed: Boolean(r.refreshed),
      };
    }

    // a re-test replaces the row it is re-testing, so a resumed scan never
    // ends up with the same account twice
    const seen = results.findIndex((r) => r.uid === row.uid);
    if (seen >= 0) results[seen] = row;
    else results.push(row);
    if (row.ok) alive++;
    else dead++;
    if (!asJson) {
      const mark = row.ok ? '✓' : '✗';
      const detail = row.ok
        ? `${row.alive}/${row.tested.length} 模型可用 · ${row.tested.filter((t) => t.ok).map((t) => t.model).join(', ')}`
        : row.error || '无回包';
      const seen = results.length;
      process.stdout.write(`  ${mark} [${String(seen).padStart(3)}] ${String(row.nickname || row.uid).padEnd(14)} ${detail}\n`);
    }

    // write as we go so a long scan survives being stopped
    writeFileSync(
      RESULT,
      JSON.stringify({ pool: dir, updatedAt: new Date().toISOString(), accounts: results }, null, 2),
      'utf8',
    );
  }
}

await Promise.all(Array.from({ length: Math.min(concurrency, target.length || 1) }, worker));

// ---- report --------------------------------------------------------------
const summary = {
  total: results.length,
  alive: results.filter((r) => r.ok).length,
  dead: results.filter((r) => !r.ok).length,
  expired: results.filter((r) => r.expired).length,
  byRealm: results.reduce((acc, r) => ({ ...acc, [r.realm || '?']: (acc[r.realm || '?'] ?? 0) + 1 }), {}),
};

writeFileSync(RESULT, JSON.stringify({ pool: dir, updatedAt: new Date().toISOString(), summary, accounts: results }, null, 2), 'utf8');

if (asJson) {
  console.log(JSON.stringify({ summary, accounts: results.map((r) => ({ uid: r.uid, nickname: r.nickname, ok: r.ok, alive: r.alive, error: r.error, realm: r.realm })) }, null, 2));
} else {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`可用 ${summary.alive} · 不可用 ${summary.dead} · 其中 token 已过期 ${summary.expired}`);
  console.log(`realm: ${Object.entries(summary.byRealm).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
  console.log(`结果: ${RESULT}`);

  // which families are refused most, which tells the user what kind of dead these are
  const fails = {};
  for (const r of results) {
    for (const t of r.tested ?? []) {
      if (!t.ok) fails[t.error] = (fails[t.error] ?? 0) + 1;
    }
  }
  const top = Object.entries(fails).sort((a, b) => b[1] - a[1]).slice(0, 6);
  if (top.length) {
    console.log('\n失败原因分布:');
    for (const [why, n] of top) console.log(`  ${String(n).padStart(4)}  ${why}`);
  }
}

// What each account has actually done, and which model it served.
//
// magpie writes one line per request to `usage.jsonl`, with the account in
// `providerAccount` and the model in `model`. So the numbers here are magpie's
// own, not a second bookkeeping system: the page cannot disagree with the
// 用量 page because it is reading the same file.
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const USAGE_FILE = join(process.env.USERPROFILE ?? homedir(), '.config', 'magpie', 'usage.jsonl');

const DAY = 864e5;

function parseLines(text, fromMs) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    // a line's timestamp is near its start, so the cheap test comes first
    if (fromMs && line.length > 30) {
      const head = line.slice(0, 40);
      const m = /\d{4}-\d{2}-\d{2}/.exec(head);
      if (m) {
        const t = Date.parse(m[0]);
        if (Number.isFinite(t) && t < fromMs - DAY) continue;
      }
    }
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    out.push(r);
  }
  return out;
}

// readUsage returns the raw records within a window, workbuddy's only.
export function readUsage({ days = 30, providers = ['workbuddy', 'workbuddy-ai'] } = {}) {
  if (!existsSync(USAGE_FILE)) return [];
  const fromMs = Date.now() - days * DAY;
  let text;
  try {
    text = readFileSync(USAGE_FILE, 'utf8');
  } catch {
    return [];
  }
  return parseLines(text, fromMs).filter((r) => {
    if (!providers.includes(r.provider)) return false;
    // model_list / probe lines are magpie's own bookkeeping, not a user's work
    if (r.kind && r.kind !== 'chat') return false;
    const t = Date.parse(r.t);
    return Number.isFinite(t) ? t >= fromMs : true;
  });
}

const empty = () => ({ requests: 0, input: 0, output: 0, cacheRead: 0, ms: 0, errors: 0, models: {}, lastAt: 0 });

// summarise folds the records into per-account and per-model totals.
export function summarise(records) {
  const accounts = {};
  const models = {};
  const total = empty();

  for (const r of records) {
    const acct = String(r.providerAccount || r.who || '').trim() || '(未标注账号)';
    const model = String(r.model || '').trim() || '(未知模型)';
    const t = Date.parse(r.t) || 0;
    const failed = r.status && (r.status < 200 || r.status >= 300);

    for (const bucket of [total, (accounts[acct] ||= empty()), (models[model] ||= empty())]) {
      bucket.requests += 1;
      bucket.input += Number(r.in) || 0;
      bucket.output += Number(r.out) || 0;
      bucket.cacheRead += Number(r.cache_read) || 0;
      bucket.ms += Number(r.ms) || 0;
      if (failed) bucket.errors += 1;
      if (t > bucket.lastAt) bucket.lastAt = t;
    }

    const am = (accounts[acct].models[model] ||= { requests: 0, input: 0, output: 0 });
    am.requests += 1;
    am.input += Number(r.in) || 0;
    am.output += Number(r.out) || 0;
    models[model].accounts ??= {};
    models[model].accounts[acct] = (models[model].accounts[acct] || 0) + 1;
  }

  return { accounts, models, total };
}

// routingOf answers "which account served which model", from the same records:
// a model's accounts, biggest share first.
export function routingOf(summary) {
  const rows = [];
  for (const [model, m] of Object.entries(summary.models)) {
    const accounts = Object.entries(m.accounts ?? {})
      .sort((a, b) => b[1] - a[1])
      .map(([acct, n]) => ({ account: acct, requests: n }));
    rows.push({ model, requests: m.requests, input: m.input, output: m.output, accounts });
  }
  return rows.sort((a, b) => b.requests - a.requests);
}

// byDay is the last N days, for a tiny trend.
export function byDay(records, days = 14) {
  const buckets = {};
  for (const r of records) {
    const t = Date.parse(r.t);
    if (!Number.isFinite(t)) continue;
    const key = new Date(t).toISOString().slice(0, 10);
    const b = (buckets[key] ||= { date: key, requests: 0, input: 0, output: 0 });
    b.requests += 1;
    b.input += Number(r.in) || 0;
    b.output += Number(r.out) || 0;
  }
  return Object.values(buckets).sort((a, b) => a.date.localeCompare(b.date)).slice(-days);
}

export function usageMtime() {
  try {
    return statSync(USAGE_FILE).mtimeMs;
  } catch {
    return 0;
  }
}

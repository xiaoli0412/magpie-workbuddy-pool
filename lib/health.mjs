// Is the account actually able to answer? Not "does the token look valid" —
// that only proves the sign-in exists. This asks a model to say something and
// waits for the first token, which is the only proof a request would go
// through.
//
// It costs almost nothing: one token of output, and the stream is dropped the
// moment the first chunk arrives. WorkBuddy refuses a non-streamed chat
// outright, so a streaming request is the only shape that can be asked at all.
import { buildOf, headersFor } from './wb.mjs';

// A model that answers cheaply, in order of preference.
const CHEAP = [/free/i, /flash/i, /-mini/i, /auto/i, /hy3/i, /glm/i];

// Errors that mean the account cannot serve, with the meaning rather than the code.
const ERRORS = {
  10085: 'User-Agent 被拒',
  11128: '提示词被判定为非批准渠道',
  11133: '请求参数被拒',
  11140: '账号被限制',
  11158: '该账号无权使用此模型',
  11217: '未完成登录',
  12151: '账号信息未就绪',
  12153: 'refresh token 已被消费',
  6004: '额度不足',
  11102: '并发超限',
};

export const CHEAP_RE = CHEAP;

function pickModel(models) {
  const list = (models || []).filter((m) => typeof m === 'string' && m);
  for (const re of CHEAP) {
    const hit = list.find((m) => re.test(m));
    if (hit) return hit;
  }
  return list[0] ?? 'auto';
}

// pickModels chooses up to `n` models that between them cover different
// vendors and both serving routes (chat and Anthropic Messages). Testing only
// one cheap model would pass an account whose Claude entitlement is gone, so
// the sample is spread across families on purpose.
export function pickModels(models, n = 4) {
  const list = [...new Set((models || []).filter((m) => typeof m === 'string' && m))];
  if (!list.length) return ['auto'];
  if (list.length <= n) return list;

  const buckets = [
    [/free/i, 'free'],
    [/flash|mini|fast/i, 'fast'],
    [/claude/i, 'claude'],
    [/glm/i, 'glm'],
    [/deepseek/i, 'deepseek'],
    [/kimi|moonshot/i, 'kimi'],
    [/gpt|o[134]/i, 'gpt'],
    [/gemini/i, 'gemini'],
    [/auto/i, 'auto'],
  ];
  const chosen = [];
  for (const [re] of buckets) {
    if (chosen.length >= n) break;
    const hit = list.find((m) => re.test(m) && !chosen.includes(m));
    if (hit) chosen.push(hit);
  }
  for (const m of list) {
    if (chosen.length >= n) break;
    if (!chosen.includes(m)) chosen.push(m);
  }
  return chosen.slice(0, n);
}

function errorOf(body) {
  try {
    const j = JSON.parse(body);
    const code = j?.code ?? j?.internal_code;
    if (code && ERRORS[code]) return `${ERRORS[code]} (${code})`;
    if (code) return `${j?.msg ?? 'error'} (${code})`;
  } catch {
    /* not JSON */
  }
  return null;
}

// listModels asks the build which models an account may use.
export async function listModels(provider, auth, { timeoutMs = 12_000 } = {}) {
  const build = buildOf(provider);
  try {
    const res = await fetch(`${build.base}/v3/config?agent=cli`, {
      headers: headersFor(provider, auth),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const j = await res.json();
    if (j?.code !== 0) return { ok: false, models: [], error: errorOf(JSON.stringify(j)) || `code ${j?.code}` };
    const agents = j?.data?.agents ?? [];
    const models = [
      ...new Set(
        agents
          .flatMap((a) => (a.models ?? []).map((m) => (typeof m === 'string' ? m : m?.id)))
          .filter(Boolean),
      ),
    ];
    return { ok: true, models, error: '' };
  } catch (e) {
    return { ok: false, models: [], error: String(e?.message ?? e).slice(0, 100) };
  }
}

// askModel sends one tiny chat to one named model and reports what came back.
export async function askModel(provider, auth, model, { timeoutMs = 25_000 } = {}) {
  const build = buildOf(provider);
  const base = build.base;
  const headers = headersFor(provider, auth);
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${base}/v2/chat/completions`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
        stream: true,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, model, ms: Date.now() - started, error: errorOf(text) || `HTTP ${res.status}`, status: res.status };
    }

    // the first chunk is the proof; drop the rest
    const reader = res.body?.getReader();
    if (!reader) return { ok: false, model, ms: Date.now() - started, error: '无响应体' };

    let buf = '';
    let ok = false;
    let said = '';
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += new TextDecoder().decode(value, { stream: true });
      if (buf.includes('"error"') || buf.includes('"code":')) {
        said = errorOf(buf) || buf.slice(0, 80);
        break;
      }
      if (buf.includes('data:')) {
        ok = true;
        break;
      }
      if (buf.length > 8192) break;
    }
    try {
      await reader.cancel();
    } catch {
      /* the abort below finishes it */
    }
    return { ok, model, ms: Date.now() - started, error: ok ? '' : said || '没有收到任何数据', status: res.status };
  } catch (e) {
    const aborted = e?.name === 'AbortError';
    return {
      ok: false,
      model,
      ms: Date.now() - started,
      error: aborted ? `超时（${Math.round(timeoutMs / 1000)}s）` : String(e?.message ?? e).slice(0, 100),
    };
  } finally {
    clearTimeout(timer);
  }
}

// ask keeps the old one-model behaviour: list the models, pick a cheap one, ask.
export async function ask(provider, auth, { timeoutMs = 25_000 } = {}) {
  const listed = await listModels(provider, auth);
  const model = listed.models.length ? pickModel(listed.models) : 'auto';
  const r = await askModel(provider, auth, model, { timeoutMs });
  return { ...r, models: listed.models.length };
}

// probeAccount is the full per-account check: list, then ask several models.
export async function probeAccount(provider, auth, { models: want = 4, timeoutMs = 25_000 } = {}) {
  const listed = await listModels(provider, auth);
  if (!listed.ok) {
    return { ok: false, error: listed.error, models: [], tested: [], ms: 0 };
  }
  const chosen = pickModels(listed.models, want);
  const tested = [];
  const started = Date.now();
  for (const model of chosen) {
    const r = await askModel(provider, auth, model, { timeoutMs });
    tested.push(r);
    // one answer is enough to call the account alive; the rest still run so the
    // report says which families work and which are refused
  }
  const alive = tested.filter((r) => r.ok).length;
  return {
    ok: alive > 0,
    error: alive ? '' : tested[0]?.error ?? '全部模型均无回包',
    models: listed.models,
    tested,
    alive,
    ms: Date.now() - started,
  };
}

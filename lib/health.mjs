// Is the account actually able to answer? Not "does the token look valid" —
// that only proves the sign-in exists. This asks a model to say something and
// waits for the first token, which is the only proof a request would go
// through.
//
// It costs almost nothing: one token of output, and the stream is dropped the
// moment the first chunk arrives. WorkBuddy refuses a non-streamed chat
// outright, so a streaming request is the only shape that can be asked at all.
import { UA, buildOf, headersFor } from './wb.mjs';

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
};

function pickModel(models) {
  const list = (models || []).filter((m) => typeof m === 'string' && m);
  for (const re of CHEAP) {
    const hit = list.find((m) => re.test(m));
    if (hit) return hit;
  }
  return list[0] ?? 'auto';
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

// ask sends one tiny chat and reports what came back.
export async function ask(provider, auth, { timeoutMs = 25_000 } = {}) {
  const build = buildOf(provider);
  const base = build.base;
  const headers = headersFor(provider, auth);

  // 1. which model to ask. A failed list is not fatal: 'auto' is always valid.
  let model = 'auto';
  let models = [];
  try {
    const res = await fetch(`${base}/v3/config?agent=cli`, {
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    const j = await res.json();
    const agents = j?.data?.agents ?? [];
    models = [...new Set(agents.flatMap((a) => (a.models ?? []).map((m) => (typeof m === 'string' ? m : m?.id)).filter(Boolean)))];
    if (models.length) model = pickModel(models);
  } catch {
    /* keep auto */
  }

  // 2. ask it something. Streaming only — WorkBuddy refuses anything else.
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
      const said = errorOf(text) || `HTTP ${res.status}`;
      return { ok: false, model, ms: Date.now() - started, error: said, models: models.length };
    }

    // 3. the first chunk is the proof; drop the rest.
    const reader = res.body?.getReader();
    if (!reader) return { ok: false, model, ms: Date.now() - started, error: '无响应体', models: models.length };

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
    return {
      ok,
      model,
      ms: Date.now() - started,
      error: ok ? '' : said || '没有收到任何数据',
      models: models.length,
    };
  } catch (e) {
    const aborted = e?.name === 'AbortError';
    return {
      ok: false,
      model,
      ms: Date.now() - started,
      error: aborted ? `超时（${Math.round(timeoutMs / 1000)}s）` : String(e?.message ?? e).slice(0, 100),
      models: models.length,
    };
  } finally {
    clearTimeout(timer);
  }
}

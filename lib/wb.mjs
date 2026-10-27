// WorkBuddy's own API, the little of it a pool needs: whose account a token
// is, how to renew it, and what is left on it.
//
// A request has to look like WorkBuddy's desktop client or WorkBuddy answers
// 10085 for a chat and will not count the call under any client. The headers
// here are the ones its own client sends; nothing is invented.
const BUILDS = {
  workbuddy: { name: 'WorkBuddy', base: 'https://copilot.tencent.com', intl: false },
  'workbuddy-ai': { name: 'WorkBuddy AI', base: 'https://www.workbuddy.ai', intl: true },
};

export const UA = 'WorkBuddy/5.5.6';

export function buildOf(provider) {
  return BUILDS[provider] ?? BUILDS.workbuddy;
}

export function headersFor(provider, auth) {
  const build = buildOf(provider);
  const h = {
    Authorization: `Bearer ${auth.access}`,
    'User-Agent': UA,
    Accept: 'application/json',
    'X-Product': 'SaaS',
    'X-IDE-Type': 'WorkBuddy',
    'X-IDE-Name': 'WorkBuddy',
  };
  if (auth.uid) h['X-User-Id'] = auth.uid;
  const domain = auth.domain || new URL(build.base).host;
  if (domain) h['X-Domain'] = domain;
  if (auth.enterpriseId) {
    h['X-Enterprise-Id'] = auth.enterpriseId;
    h['X-Tenant-Id'] = auth.enterpriseId;
  }
  return h;
}

async function call(provider, auth, method, path, extra = {}, body, timeoutMs = 15000) {
  const build = buildOf(provider);
  const url = build.base + path;
  const headers = { ...headersFor(provider, auth), ...extra };
  const init = { method, headers, signal: AbortSignal.timeout(timeoutMs) };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url, init);
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, json, text, url };
}

// probe tells which build accepts an account and who it is. It is the only
// honest way to place a token: an export's own labels can be wrong.
export async function probe(provider, auth) {
  const who = await call(provider, auth, 'GET', '/v2/plugin/accounts');
  if (who.status === 401 || who.status === 403) return { ok: false, status: who.status, reason: 'refused' };
  if (who.json?.code !== 0) {
    return { ok: false, status: who.status, reason: who.json?.msg || `code ${who.json?.code}`, raw: who.text.slice(0, 200) };
  }
  const account = who.json?.data?.accounts?.[0] ?? {};
  return {
    ok: true,
    status: who.status,
    uid: account.uid ?? '',
    nickname: account.nickname ?? '',
    phone: account.phoneNumber ?? '',
    type: account.type ?? '',
    enterpriseId: account.isCurrentOneIdEnterprise ? 'enterprise' : '',
    build: buildOf(provider).intl ? 'intl' : 'cn',
  };
}

// renew spends a refresh token. WorkBuddy answers with a whole new token pair
// and its own lifetime, which is what gets stored.
export async function renew(provider, auth) {
  if (!auth.refresh) throw new Error('no refresh token to spend');
  const got = await call(
    provider,
    auth,
    'POST',
    '/v2/plugin/auth/token/refresh',
    {
      'X-Refresh-Token': auth.refresh,
      'X-Auth-Refresh-Source': 'plugin',
      'X-Domain': auth.domain || new URL(buildOf(provider).base).host,
    },
    {},
  );
  const data = got.json?.data ?? got.json;
  if (!data?.accessToken) {
    const said = got.json?.msg || got.text.slice(0, 120) || `HTTP ${got.status}`;
    const err = new Error(`refresh refused: ${said}`);
    err.refused = got.status === 401 || got.status === 403;
    throw err;
  }
  const now = Date.now();
  return {
    access: data.accessToken,
    refresh: data.refreshToken || auth.refresh,
    expires: data.expiresAt > 0 ? data.expiresAt : data.expiresIn > 0 ? now + data.expiresIn * 1000 : auth.expires,
    refreshExpiresAt:
      data.refreshExpiresAt > 0
        ? data.refreshExpiresAt
        : data.refreshExpiresIn > 0
          ? now + data.refreshExpiresIn * 1000
          : auth.refreshExpiresAt,
    domain: data.domain || auth.domain,
    tokenType: data.tokenType || auth.tokenType || 'Bearer',
  };
}

// credits reads what a build says is left, in whatever shape it answers.
// A build that does not answer leaves the field out rather than failing.
export async function credits(provider, auth) {
  const paths = [
    '/billing/meter/get-user-resource-summary',
    '/billing/meter/get-user-resource-free-packages',
  ];
  for (const path of paths) {
    try {
      const got = await call(provider, auth, 'GET', path, {}, undefined, 10000);
      if (got.json?.code === 0 && got.json.data) return { path, data: got.json.data };
    } catch {
      // try the next one
    }
  }
  return null;
}

// models asks the build which models this account may use.
export async function models(provider, auth) {
  try {
    const got = await call(provider, auth, 'GET', '/v3/config?agent=cli', {}, undefined, 15000);
    if (got.json?.code !== 0) return [];
    const agents = got.json?.data?.agents ?? [];
    const out = new Set();
    for (const agent of agents) {
      for (const m of agent.models ?? []) {
        const id = typeof m === 'string' ? m : m?.id ?? m?.model;
        if (id) out.add(id);
      }
    }
    return [...out];
  } catch {
    return [];
  }
}

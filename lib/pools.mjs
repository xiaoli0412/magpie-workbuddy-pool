// Reading a pool: every account export dropped into magpie's pool folder,
// whichever shape it came in, made into one record shape.
//
// The exports people have are not all alike. A CodeBuddy export carries
// `auth_raw` with a domain and a session state; a WorkBuddy pool export carries
// a bare `origin` tag and an 8-digit number; both carry `access_token` and
// `refresh_token` at the top. A record is normalised once here so nothing
// downstream has to know which exporter produced it.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, basename, extname } from 'node:path';

export const CONFIG_DIR = join(process.env.USERPROFILE ?? homedir(), '.config', 'magpie');
export const POOL_DIR = join(CONFIG_DIR, 'workbuddy-pool');
export const AUTH_FILE = join(CONFIG_DIR, 'plugin-auth.json');
export const STATE_FILE = join(POOL_DIR, 'state.json');

const sec = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

// normalise turns one exported record into the pool's own shape.
export function normalise(raw = {}, sourceFile = '') {
  const authRaw = raw.auth_raw ?? {};
  const profile = raw.profile_raw ?? {};

  const access = String(raw.access_token ?? authRaw.accessToken ?? '').trim();
  const refresh = String(raw.refresh_token ?? authRaw.refreshToken ?? '').trim();
  if (!access) return null;

  // Exports time the access token in seconds; magpie times it in ms.
  const expiresSec = sec(raw.expires_at) || sec(authRaw.expiresAt);
  const expiresMs = expiresSec
    ? expiresSec * 1000
    : sec(authRaw.expiresIn)
      ? Date.now() + sec(authRaw.expiresIn) * 1000
      : 0;

  const refreshExpiresSec = sec(authRaw.refreshExpiresAt);
  const refreshExpiresMs = refreshExpiresSec
    ? refreshExpiresSec * 1000
    : sec(authRaw.refreshExpiresIn)
      ? Date.now() + sec(authRaw.refreshExpiresIn) * 1000
      : 0;

  const phone = String(
    profile.phoneNumber ?? authRaw.phoneNumber ?? raw.phone ?? raw.email ?? raw.nickname ?? '',
  ).trim();

  const uid = String(raw.uid ?? authRaw.uid ?? '').trim();
  if (!uid) return null;

  return {
    uid,
    access,
    refresh,
    expiresMs,
    refreshExpiresMs,
    domain: String(authRaw.domain ?? raw.domain ?? '').trim(),
    origin: String(raw.origin ?? authRaw.origin ?? '').trim(),
    tokenType: String(raw.token_type ?? authRaw.tokenType ?? 'Bearer'),
    phone,
    nickname: String(raw.nickname ?? profile.nickname ?? '').trim(),
    status: String(raw.status ?? '').trim(),
    enterpriseId: String(authRaw.enterpriseId ?? profile.enterpriseId ?? '').trim(),
    createdAt: sec(raw.created_at),
    lastUsed: sec(raw.last_used),
    sourceFile: basename(sourceFile),
  };
}

// keyFor is the auth key a record is stored under: the provider, a '#', and a
// short stable digest of the uid, which is the shape magpie itself uses for a
// provider's second and later accounts.
export function keyFor(provider, uid) {
  const digest = createHash('sha256').update(`${provider}\n${uid}`).digest('hex').slice(0, 7);
  return `${provider}#${digest}`;
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// loadFile reads one export file and returns its normalised records. A file
// that holds a single object, or a wrapper with `accounts`, is accepted too.
export function loadFile(file) {
  const data = readJson(file);
  if (!data) return { file, name: basename(file), records: [], error: 'not JSON' };
  let list;
  if (Array.isArray(data)) list = data;
  else if (Array.isArray(data.accounts)) list = data.accounts;
  else if (Array.isArray(data.data)) list = data.data;
  else list = [data];

  const records = [];
  for (const item of list) {
    const n = normalise(item, file);
    if (n) records.push(n);
  }
  return { file, name: basename(file), records, error: records.length ? '' : 'no usable account' };
}

// listPoolFiles is every account export in the pool folder, newest first. The
// pool's own bookkeeping (state, throttle, last import) is dot-prefixed or
// named, and is never mistaken for an export.
const NOT_A_POOL = new Set(['state.json', 'last-import.json']);
export function listPoolFiles(dir = POOL_DIR) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => extname(n).toLowerCase() === '.json' && !n.startsWith('.') && !NOT_A_POOL.has(n))
    .map((n) => join(dir, n))
    .filter((p) => {
      try {
        return statSync(p).isFile();
      } catch {
        return false;
      }
    })
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
}

// loadPools reads every pool file and folds duplicate uids into one record,
// keeping the copy with the longest-lived access token.
export function loadPools(dir = POOL_DIR) {
  const files = listPoolFiles(dir);
  const byUid = new Map();
  const problems = [];

  for (const file of files) {
    const { records, error, name } = loadFile(file);
    if (error) problems.push({ file: name, error });
    for (const rec of records) {
      const seen = byUid.get(rec.uid);
      if (!seen) {
        byUid.set(rec.uid, rec);
        continue;
      }
      // Same account in two exports: keep whichever token lives longer, and
      // remember the other file so nothing looks lost.
      const better = rec.expiresMs > seen.expiresMs ? rec : seen;
      const other = better === rec ? seen : rec;
      better.alsoIn = [...new Set([...(seen.alsoIn ?? []), ...(rec.alsoIn ?? []), other.sourceFile])].filter(
        (f) => f !== better.sourceFile,
      );
      byUid.set(rec.uid, better);
    }
  }

  return { files, records: [...byUid.values()], problems };
}

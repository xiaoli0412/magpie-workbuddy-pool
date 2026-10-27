// magpie's auth store, edited as a file.
//
// magpie keeps every plugin sign-in in one JSON object: a provider's first
// account under the provider's own id, its second and later under
// "<provider>#<suffix>". The community WorkBuddy plugin writes there through
// the host's API; a pool importer has to keep the same file byte-honest, so
// everything here is read-modify-write with a backup taken first and a rename
// that is atomic on Windows.
import { readFileSync, writeFileSync, renameSync, copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

export function readAuth(file) {
  const raw = readFileSync(file, 'utf8');
  const data = JSON.parse(raw);
  // Older stores are the plain object; newer ones wrap it as { accounts }.
  const store = data && typeof data === 'object' && data.accounts && typeof data.accounts === 'object'
    ? data.accounts
    : data;
  return { data, store };
}

// writeAuth writes the whole store back atomically, keeping the previous file
// as <file>.pool.bak so a bad import is one copy away from undone.
export function writeAuth(file, data) {
  const text = JSON.stringify(data, null, 2);
  const tmp = `${file}.pool.tmp`;
  if (existsSync(file)) copyFileSync(file, `${file}.pool.bak`);
  writeFileSync(tmp, text, 'utf8');
  renameSync(tmp, file);
}

// accountKey peels "<provider>#<suffix>" back to its provider.
export function providerOfKey(key) {
  const i = String(key).indexOf('#');
  return i === -1 ? String(key) : String(key).slice(0, i);
}

// accountsOf lists a provider's accounts in the store, primary key first.
export function accountsOf(store, provider) {
  return Object.entries(store)
    .filter(([k]) => providerOfKey(k) === provider)
    .map(([key, value]) => ({ key, auth: value?.auth ?? value }));
}

// ensureDir makes a folder when it is missing.
export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
}

// atomicJson writes any JSON file the same careful way.
export function atomicJson(file, value) {
  ensureDir(dirname(file));
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  renameSync(tmp, file);
}

export function readJsonFile(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function mtimeOf(file) {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

// Waiting work the page leaves in this plugin's own options.
//
// A plugin page runs in a sandbox: no network, no filesystem, and no API of
// magpie's except `magpie.read` for two whitelisted reads. The one thing it can
// write is its plugin's own options (`magpie.options.set` → POST
// /api/plugin-pages/options → plugins.json). So that is the mailbox: the page
// puts an import there, and this module takes it out again the next time the
// plugin is loaded, leaving the option clean behind it.
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CONFIG_DIR } from './pools.mjs';

export const PLUGINS_FILE = join(CONFIG_DIR, 'plugins.json');
export const PACKAGE_NAME = 'magpie-workbuddy-pool';

// entryOf finds this plugin's own row in plugins.json by the package name its
// spec resolves to, which is the only identity a plugin has there.
export function entryOf(file = PLUGINS_FILE) {
  let data;
  try {
    data = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return { data: null, index: -1, entry: null };
  }
  const plugins = Array.isArray(data?.plugins) ? data.plugins : [];
  for (let i = 0; i < plugins.length; i++) {
    const spec = plugins[i]?.spec;
    if (typeof spec !== 'string' || !spec.startsWith('.') && !/^[A-Za-z]:[\\/]/.test(spec) && !spec.startsWith('/')) continue;
    const dir = resolve(spec);
    const pkg = join(dir, 'package.json');
    if (!existsSync(pkg)) continue;
    try {
      if (JSON.parse(readFileSync(pkg, 'utf8')).name === PACKAGE_NAME) return { data, index: i, entry: plugins[i] };
    } catch {
      // not ours
    }
  }
  return { data, index: -1, entry: null };
}

export function pendingOf(file = PLUGINS_FILE) {
  const { entry } = entryOf(file);
  return entry?.options?.pendingImport ?? null;
}

// clearPending removes the import this run consumed, and nothing else.
export function clearPending(file = PLUGINS_FILE) {
  const { data, index, entry } = entryOf(file);
  if (index < 0) return false;
  if (!entry.options || !('pendingImport' in entry.options)) return false;
  const { pendingImport, ...rest } = entry.options;
  entry.options = rest;
  const tmp = `${file}.pool.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  renameSync(tmp, file);
  return true;
}

// stage is what the page calls its submission: the text, a name, and when.
export function isStage(value) {
  return Boolean(value && typeof value === 'object' && typeof value.text === 'string' && value.text.trim());
}

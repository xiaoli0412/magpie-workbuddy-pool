// Waiting work the page leaves in this plugin's own options.
//
// A plugin page runs in a sandbox: no network, no filesystem, and no API of
// magpie's except `magpie.read` for two whitelisted reads. The one thing it can
// write is its plugin's own options (`magpie.options.set` → POST
// /api/plugin-pages/options → plugins.json). So that is the mailbox: the page
// puts an import there, and this module takes it out again the next time the
// plugin is loaded, leaving the option clean behind it.
//
// Finding "my own row" is the fiddly part: a plugin is installed by a path, by
// `github:owner/repo`, or from npm, and only the last two land in
// plugins/node_modules. So it is looked for three ways, in order of certainty.
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CONFIG_DIR } from './pools.mjs';

export const PLUGINS_FILE = join(CONFIG_DIR, 'plugins.json');
export const PACKAGE_NAME = 'magpie-workbuddy-pool';
export const INSTALLED = join(CONFIG_DIR, 'plugins', 'node_modules', PACKAGE_NAME);

function isMine(spec) {
  if (typeof spec !== 'string' || !spec) return false;
  // an installed package, however it was named in plugins.json
  try {
    return JSON.parse(readFileSync(join(INSTALLED, 'package.json'), 'utf8')).name === PACKAGE_NAME;
  } catch {
    return false;
  }
}

function isPathSpec(spec) {
  return typeof spec === 'string' && (spec.startsWith('.') || spec.startsWith('/') || /^[A-Za-z]:[\\/]/.test(spec));
}

function packageNameAt(spec) {
  try {
    return JSON.parse(readFileSync(join(resolve(spec), 'package.json'), 'utf8')).name;
  } catch {
    return null;
  }
}

// entryOf finds this plugin's row: by the package a path spec resolves to, by
// the package magpie installed for a registry or GitHub spec, or — last — by
// being the only row holding an import in its options.
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
    if (!isPathSpec(spec)) continue;
    if (!existsSync(resolve(spec))) continue;
    if (packageNameAt(spec) === PACKAGE_NAME) return { data, index: i, entry: plugins[i] };
  }

  for (let i = 0; i < plugins.length; i++) {
    const spec = plugins[i]?.spec;
    if (isPathSpec(spec)) continue;
    if (!isMine(spec)) continue;
    return { data, index: i, entry: plugins[i] };
  }

  // An install magpie named some other way (a tarball, an alias): the only
  // plugin that puts an import in its options is this one.
  for (let i = 0; i < plugins.length; i++) {
    if (plugins[i]?.options && 'pendingImport' in plugins[i].options) return { data, index: i, entry: plugins[i] };
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

// isStage is what the page submits: the text, a name, and when.
export function isStage(value) {
  return Boolean(value && typeof value === 'object' && typeof value.text === 'string' && value.text.trim());
}

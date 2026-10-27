// Region rules: 大陆 (cn) / 港澳台 (hmt) / 国际 (intl) / 未知 (unknown).
//
// Neither the export files nor WorkBuddy's own account API carry a country
// field, so a region is worked out from what a record does carry.
//
// Two facts decide it, in this order:
//
//   1. Which of WorkBuddy's two builds issued the token. A live probe of the
//      account (or the export's domain) says this outright, and both mainland
//      and 港澳台 accounts sign in to the *China* build, so this step only ever
//      separates 国际 from 中国大陆构建 — never 大陆 from 港澳台.
//   2. Inside the China build, what the number and the export's origin say.
//      A mainland mobile is 11 digits beginning with 1; Hong Kong and Macau
//      numbers are 8; a Taiwan mobile is 10 beginning 09. An explicit origin
//      tag such as "wb852" outranks a number's shape.
//
// Guessing wrong here is worse than saying nothing, so an account no evidence
// places comes back as 未知 instead of being folded into 大陆.

export const REGIONS = ['cn', 'hmt', 'intl', 'unknown'];

export const REGION_LABEL = {
  cn: '大陆',
  hmt: '港澳台',
  intl: '国际',
  unknown: '未知',
};

const CN_MOBILE = /^1[3-9]\d{9}$/;
const HK_MO = /^[2-9]\d{7}$/;
const TW_MOBILE = /^09\d{8}$/;

const digits = (v) => String(v ?? '').replace(/\D/g, '');

// regionOfDomain: the domain a token was issued by names its build.
export function regionOfDomain(domain) {
  const d = String(domain ?? '').toLowerCase().trim();
  if (!d) return null;
  if (/(^|\.)(codebuddy\.cn|workbuddy\.cn|codebuddy\.com\.cn)$/.test(d)) return 'cn';
  if (/(^|\.)(workbuddy\.ai|codebuddy\.ai|workbuddy\.com|codebuddy\.com)$/.test(d)) return 'intl';
  return null;
}

// regionOfOrigin: an export's own pool tag, e.g. "wb852".
export function regionOfOrigin(origin) {
  const o = String(origin ?? '').toLowerCase().trim();
  if (!o) return null;
  if (o.includes('852') || o.includes('hk') || o.includes('hmt') || o.includes('hongkong')) return 'hmt';
  if (o.includes('tw') || o.includes('taiwan') || o.includes('mo') || o.includes('macau')) return 'hmt';
  if (o.includes('intl') || o.includes('global') || o.includes('ai')) return 'intl';
  if (o.includes('cn') || o.includes('mainland') || o.includes('china')) return 'cn';
  return null;
}

// regionOfPhone: a number's shape narrows a region on its own.
export function regionOfPhone(phone) {
  const n = digits(phone);
  if (!n) return null;
  if (CN_MOBILE.test(n)) return 'cn';
  if (TW_MOBILE.test(n)) return 'hmt';
  if (HK_MO.test(n)) return 'hmt';
  if (n.length === 13 && n.startsWith('86') && CN_MOBILE.test(n.slice(2))) return 'cn';
  return null;
}

// regionOfFileName: the operator's own naming of a pool, the weakest signal.
export function regionOfFileName(name) {
  const f = String(name ?? '').toLowerCase();
  if (f.includes('852') || f.includes('hk') || f.includes('hmt') || f.includes('taiwan')) return 'hmt';
  if (f.includes('intl') || f.includes('global')) return 'intl';
  if (f.includes('cn') || f.includes('mainland')) return 'cn';
  return null;
}

// classify returns { region, label, build, reasons } for one record.
//
// `options.probe` is the build a live request was accepted by ('cn' | 'intl'),
// the strongest evidence available when it exists.
export function classify(account = {}, options = {}) {
  const reasons = [];
  const add = (from, region) => {
    if (region) reasons.push({ from, region });
  };

  const probeRegion = options.probe ? (options.probe === 'intl' ? 'intl' : 'cn') : null;
  const domainRegion = regionOfDomain(account.domain);
  const originRegion = regionOfOrigin(account.origin);
  const phoneRegion = regionOfPhone(account.phone);
  const fileRegion = regionOfFileName(options.fileName ?? account.sourceFile);

  add('probe', probeRegion);
  add('domain', domainRegion);
  add('origin', originRegion);
  add('phone', phoneRegion);
  add('file', fileRegion);

  // Step 1 — is this the international build at all? Only a build fact can say
  // so; a number's shape must never send an account to the other build.
  const buildSaysIntl = probeRegion === 'intl' || domainRegion === 'intl' || originRegion === 'intl';
  if (buildSaysIntl) {
    return { region: 'intl', label: REGION_LABEL.intl, build: 'intl', reasons };
  }

  const build = probeRegion === 'cn' || domainRegion === 'cn' ? 'cn' : 'unknown';

  // Step 2 — inside the China build, the number and the pool's own tag decide.
  const hmt = originRegion === 'hmt' || phoneRegion === 'hmt' || (fileRegion === 'hmt' && phoneRegion !== 'cn');
  if (hmt) return { region: 'hmt', label: REGION_LABEL.hmt, build, reasons };

  if (phoneRegion === 'cn' || domainRegion === 'cn' || fileRegion === 'cn') {
    return { region: 'cn', label: REGION_LABEL.cn, build, reasons };
  }

  // A token the China build accepted, with nothing else to go on, is still a
  // China-build account; it is kept apart from a confirmed 大陆 one instead of
  // being presented as something it was not checked to be.
  if (build === 'cn') return { region: 'cn', label: REGION_LABEL.cn, build, reasons };

  return { region: 'unknown', label: REGION_LABEL.unknown, build, reasons };
}

// providerFor is which of magpie's two native WorkBuddy providers an account
// is stored under. Both builds are separate providers in magpie and a token is
// only accepted by the build that issued it.
export function providerFor(region) {
  return region === 'intl' ? 'workbuddy-ai' : 'workbuddy';
}

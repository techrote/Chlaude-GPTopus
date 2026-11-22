import { MODES, PROFILE_RANK, SURFACE_KEYS, modeFlags, resolveConfig, validateConfig } from './config.mjs';
import { intersectPermissions } from './policy.mjs';

// Owner policy can only TIGHTEN a mission that is already open. A mission freezes the
// configuration it was authorised under; when the owner later edits the policy, the
// effective configuration of every open mission becomes the stricter of the two, field
// by field, for everything that carries capability, reach or budget. Nothing here can
// enlarge either input: each rule is a minimum, an intersection or a conjunction.
//
// Deliberately NOT attenuated, because they are identity and governance rules frozen at
// admission and are not capability ceilings: worker/model classification, authority
// profiles, HELICOP rules, risk thresholds, free-to-paid policy, execution authorities
// and review/test policy. Changing those takes effect for a new host session.

const clone = value => structuredClone(value);
/** null means "unlimited"; the tighter of two limits is the smaller finite one. */
const tighter = (a, b) => a === null || a === undefined ? (b ?? null) : b === null || b === undefined ? a : Math.min(a, b);
const modeNamed = flags => Object.entries(MODES).find(([, spec]) => Object.keys(spec).every(key => spec[key] === flags[key]))?.[0] ?? 'CUSTOM';
const minProfile = (a, b) => PROFILE_RANK[a] <= PROFILE_RANK[b] ? a : b;

/**
 * The stricter of a stored (frozen) mission configuration and the CURRENT owner
 * configuration. Both inputs are validated; any malformed input throws, so callers
 * fail closed. A stored configuration written before a section existed is read
 * through the current defaults, which are think-only and unlimited-nothing.
 */
export function attenuateConfig(stored, current) {
  for (const input of [stored, current]) if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Policy attenuation needs two configuration objects');
  const base = resolveConfig(stored), now = resolveConfig(current);
  const next = clone(base);

  const a = modeFlags(base.recruitment.mode, base.recruitment.custom), b = modeFlags(now.recruitment.mode, now.recruitment.custom);
  const flags = Object.fromEntries(Object.keys(a).map(key => [key, a[key] && b[key]]));
  const keepsStored = Object.keys(a).every(key => a[key] === flags[key]);
  if (!keepsStored) { next.recruitment.mode = modeNamed(flags); next.recruitment.custom = flags; }
  next.recruitment.reviewHigher = base.recruitment.reviewHigher && now.recruitment.reviewHigher;

  next.permissions = intersectPermissions(base.permissions, now.permissions);

  for (const pool of ['core', 'review']) {
    const was = base.fleets[pool], is = now.fleets[pool], out = next.fleets[pool];
    for (const field of ['maxDepth', 'maxInvocations', 'concurrency']) out[field] = Math.min(was[field], is[field]);
    // Reserved reviewer capacity is protection: more is stricter. It must still leave an ordinary slot.
    out.reserved = pool === 'core' ? 0 : Math.min(Math.max(was.reserved, is.reserved), out.concurrency - 1);
  }

  for (const field of ['maxTokens', 'maxUsd', 'maxWallMs', 'requestsPerMinute']) next.mission[field] = tighter(base.mission[field], now.mission[field]);
  for (const field of ['maxOutstanding', 'maxJobs', 'maxRetries']) next.mission[field] = Math.min(base.mission[field], now.mission[field]);
  for (const group of ['perKey', 'perModel']) {
    const merged = {};
    for (const key of new Set([...Object.keys(base.mission[group]), ...Object.keys(now.mission[group])])) {
      // A limit for a model the stored mission never classified cannot apply to it.
      if (group === 'perModel' && !Object.hasOwn(base.models, key)) continue;
      const was = base.mission[group][key] ?? {}, is = now.mission[group][key] ?? {};
      merged[key] = Object.fromEntries(['maxTokens', 'maxUsd', 'maxRequests'].map(field => [field, tighter(was[field], is[field])]));
    }
    next.mission[group] = merged;
  }

  next.desktop.profile = minProfile(base.desktop.profile, now.desktop.profile);
  next.desktop.enableExecutionBridge = base.desktop.enableExecutionBridge && now.desktop.enableExecutionBridge;
  next.desktop.roots = base.desktop.roots.filter(root => now.desktop.roots.includes(root));
  for (const surface of SURFACE_KEYS) {
    next.surfaces[surface].profile = minProfile(base.surfaces[surface].profile, now.surfaces[surface].profile);
    next.surfaces[surface].enableExecutionBridge = base.surfaces[surface].enableExecutionBridge && now.surfaces[surface].enableExecutionBridge;
  }
  return validateConfig(next);
}


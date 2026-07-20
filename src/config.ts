import type { EligibilityConfig, SoftCategory } from '@dszp/netsapiens-lib';
import type { MappingConfig } from '@dszp/ringotel-lib';

export class ConfigError extends Error {}

export interface Env {
  SSO_BASIC_USER?: string;
  SSO_BASIC_PASSWORD?: string;
  NS_SERVER?: string;
  NS_OAUTH_SERVER?: string;
  NS_OAUTH_CLIENT_ID?: string;
  NS_OAUTH_CLIENT_SECRET?: string;
  NS_API_KEY?: string;
  NS_ADMIN_USER?: string;
  NS_ADMIN_PASS?: string;
  RINGOTEL_API_KEY?: string;
  DEVICE_SUFFIX?: string;
  SSO_HEAL_DOMAINS?: string;
  SSO_PROVISION_DOMAINS?: string;
  /**
   * Domains where a successful `allow` may repair a MISSING softphone device after the response has
   * already been sent. Empty/unset ⇒ OFF (no post-response writes at all), `*` ⇒ all domains, else a
   * comma-separated allowlist of FULL domains. Separate from SSO_HEAL_DOMAINS on purpose: healing acts
   * on the Ringotel record during the request, whereas this writes to the telephony platform for a
   * login that was already approved, so it is opted into deliberately rather than inherited.
   */
  SSO_REPAIR_DOMAINS?: string;
  /**
   * FULL NetSapiens domains (with territory suffix) REFUSED outright, before any mode is considered — a login for one of these is denied even
   * though the user's NetSapiens credentials are valid. Empty/unset ⇒ nothing blocked (default: allow
   * every domain). `*` blocks everything, which is a kill switch for the whole deployment.
   *
   * NOTE this can only be evaluated AFTER the NetSapiens credential check, because the domain is taken
   * from the user's own self-record and never from caller input — so a blocked user is authenticated
   * against NetSapiens first and then refused. That ordering is deliberate (identity is never trusted
   * from the request), not an oversight.
   */
  SSO_BLOCK_DOMAINS?: string;
  /** FULL NetSapiens domains (or `*`) where heal is refused even if SSO_HEAL_DOMAINS would allow it.
   *  `*` is NOT equivalent to emptying SSO_HEAL_DOMAINS: provision mode heals too, so blocking heal
   *  everywhere alongside a broad provision allowlist yields "create missing users, never modify
   *  existing ones". Block always wins. */
  SSO_HEAL_BLOCK_DOMAINS?: string;
  /** FULL NetSapiens domains (or `*`) where provisioning is refused even if SSO_PROVISION_DOMAINS allows. */
  SSO_PROVISION_BLOCK_DOMAINS?: string;
  /** FULL NetSapiens domains (or `*`) where post-response repair is refused even if SSO_REPAIR_DOMAINS allows. */
  SSO_REPAIR_BLOCK_DOMAINS?: string;
  /**
   * Extensions that must never gain a softphone device, regardless of domain policy. Comma-separated;
   * a trailing `*` is a prefix wildcard (`90*` covers 900, 901, 9012…; a bare `*` blocks every
   * extension everywhere). This blocks every path that
   * would CREATE a device — provision, heal, and post-response repair — but deliberately does NOT block
   * the login itself: an extension that already has a working record keeps working. Empty ⇒ nothing
   * blocked.
   *
   * Distinct from `RINGOTEL_EXCLUDE_EXTS`, which is a *soft* eligibility rule gating auto-creation only:
   * a soft exclusion still permits heal and repair, on the reasoning that an existing record implies
   * somebody deliberately made one. This list is the harder statement — "no device here, ever".
   */
  SSO_BLOCK_EXTS?: string;
  /**
   * Per-domain overrides for `SSO_BLOCK_EXTS`, as JSON keyed by FULL NetSapiens domain:
   * `{"a.12345.service": {"remove": ["900"]}, "b.12345.service": {"add": ["8000"]}}`. Applied on top of
   * the global list (add, then remove), so the usual shape is "blocked everywhere, permitted on one".
   */
  SSO_BLOCK_EXTS_BY_DOMAIN?: string;
  /**
   * Request paths this Worker answers `POST` on. Comma-separated; default `/authorize`. Ringotel's SSO
   * service definition holds whatever endpoint URL was configured for YOUR integration — often not
   * `/authorize` (e.g. a proxy's `/webhook/<id>`) — and changing it is a vendor-side support request.
   * Accepting a LIST lets one deploy answer on both the old and new paths at once, so moving traffic
   * (e.g. retiring a proxy in front of this Worker) is a DNS change with an instant rollback, not a
   * flag day. `/health` is always served regardless of this setting.
   */
  SSO_PATHS?: string;
  /**
   * Whether an SSO-initiated activation should send Ringotel's credentials email. **Default: false.**
   * A user who reached us through SSO authenticated with their NetSapiens credentials and is already
   * inside the app, so the emailed app password is noise to them. Set truthy ("1"/"true"/"yes"/"on")
   * for deployments that DO want it — e.g. where users also sign in directly rather than via SSO, or
   * where the emailed QR code is the intended onboarding path.
   *
   * Mechanically this drives Ringotel's `noemail` flag (inverted). The credentials email fires when a
   * write carries BOTH `status: 1` and an `email` field — which every heal/provision write here does,
   * because it also syncs the NetSapiens name/email into the directory entry.
   */
  SSO_SEND_ACTIVATION_EMAIL?: string;
  /**
   * Whether auto-provisioning requires the NetSapiens user to have an email address.
   * `auto` (default) · `always` · `never`.
   *
   * The underlying rule exists because activation traditionally emails the credentials, so it cannot
   * proceed without somewhere to send them. `auto` therefore ties the requirement to its own reason:
   * an address is required exactly when `SSO_SEND_ACTIVATION_EMAIL` means one will actually be used.
   * With the email suppressed (the default), a user without an address provisions normally.
   *
   * `always` keeps the requirement regardless — useful where "has no email address" is a deliberate
   * marker for staff who should not be given an app login at all. `never` drops it entirely.
   *
   * This only affects CREATION (`verdict: none`). It never gates an existing user: someone who already
   * has a Ringotel record signs in, and is healed if inactive, whether or not they have an address.
   *
   * Deployment-wide: there is no per-domain override for this yet, unlike the heal/provision/repair
   * allow/block pairs.
   */
  SSO_REQUIRE_EMAIL?: string;
  SSO_DOMAIN_MAP?: string;
  RINGOTEL_EXCLUDE_NAMES?: string;
  RINGOTEL_EXCLUDE_EXTS?: string;
  RINGOTEL_EXCLUDE_EXTS_BY_DOMAIN?: string;
  /**
   * OPTIONAL Cloudflare Workers Rate Limiting binding, keyed per-account (`domain:username`) rather
   * than per-IP — callers are Ringotel's (or a proxy's) servers, so a handful of source IPs carry
   * every account's traffic; a per-IP limit would throttle all users collectively instead of stopping
   * a brute-forcer against one account. Declared in wrangler.jsonc as a `ratelimits` binding; absent
   * ⇒ the check is skipped entirely (fail open) — rate limiting is an abuse control, not an auth
   * control, and a fork/deployment without the binding must still authenticate normally.
   *
   * ⚠️ VERIFY IT ENFORCES. Observed on at least one account: the binding present, `.limit()` returning
   * `{success:true}` for every call (18 concurrent same-key requests, no 429). Because this fails open
   * by design, a non-enforcing binding is completely silent — no error, no warning, no limiting.
   */
  SSO_RATE_LIMITER?: { limit(opts: { key: string }): Promise<{ success: boolean }> };
}

export type WriteIdentity = { kind: 'api'; token: string } | { kind: 'admin'; user: string; pass: string };

/**
 * Parsed configuration. Every domain-valued field holds **full NetSapiens domains** (with territory
 * suffix) — never the short label from `username`, and never the Ringotel org domain. `mapping` is the
 * one exception: it bridges a NetSapiens first-label to a Ringotel org key.
 */
export interface Config {
  basicUser: string;
  basicPassword: string;
  nsServer: string;
  nsOauthServer: string;
  oauthClientId: string;
  oauthClientSecret: string;
  writeIdentity: WriteIdentity;
  ringotelToken: string;
  suffix: string;
  healDomains: string[] | '*';
  provisionDomains: string[] | '*';
  repairDomains: string[] | '*';
  /** Refused outright, before mode selection. Block always wins over any allowlist. */
  blockDomains: string[] | '*';
  healBlockDomains: string[] | '*';
  provisionBlockDomains: string[] | '*';
  repairBlockDomains: string[] | '*';

  /** Extensions barred from gaining a device (provision/heal/repair). Wildcards allowed. */
  blockExts: string[];
  /** Per-domain add/remove applied over `blockExts`, keyed by lowercased full NetSapiens domain. */
  blockExtsByDomain: Record<string, { add?: string[]; remove?: string[] }>;
  /** Paths answered on POST (always at least one). `/health` is handled before this. */
  paths: string[];
  /** Send Ringotel's credentials email on an SSO-initiated activation. Default false. */
  sendActivationEmail: boolean;
  /** Require an email address to auto-provision: 'auto' follows sendActivationEmail. */
  requireEmail: 'auto' | 'always' | 'never';
  eligibility: EligibilityConfig;
  mapping: MappingConfig;
}

const csv = (s?: string): string[] => (s ?? '').split(',').map((x) => x.trim()).filter(Boolean);
const truthy = (s?: string): boolean => /^(1|true|yes|on)$/i.test((s ?? '').trim());
const req = (v: string | undefined, name: string): string => {
  const t = (v ?? '').trim();
  if (!t) throw new ConfigError(`${name} is required`);
  return t;
};

function parseList(s?: string): string[] | '*' {
  const t = (s ?? '').trim();
  return t === '*' ? '*' : csv(s).map((x) => x.toLowerCase());
}

/**
 * Accepted request paths. Empty/unset ⇒ just `/authorize`. Each entry is trimmed and forced to a single
 * leading slash, so `authorize`, `/authorize` and ` /authorize ` all configure the same route. Query
 * strings and trailing slashes are NOT stripped — the comparison is against `URL.pathname`, so configure
 * the exact path Ringotel posts to. Never returns an empty list: a blank value must not make the Worker
 * answer on nothing (a deploy that accepts no requests fails silently, which is worse than the default).
 */
function parsePaths(s?: string): string[] {
  const list = csv(s).map((p) => '/' + p.replace(/^\/+/, ''));
  return list.length ? [...new Set(list)] : ['/authorize'];
}

/** `auto` (default) | `always` | `never`. Anything else is a hard config error — a typo here would
 *  silently change who gets auto-provisioned, so it fails closed at parse time rather than guessing. */
function parseRequireEmail(v?: string): 'auto' | 'always' | 'never' {
  const t = (v ?? '').trim().toLowerCase();
  if (!t) return 'auto';
  if (t === 'auto' || t === 'always' || t === 'never') return t;
  throw new ConfigError(`SSO_REQUIRE_EMAIL must be one of auto|always|never (got "${v}")`);
}

/** Shared JSON parser for the per-domain `{add, remove}` override shape, with a named error. */
function parseByDomain(raw: string | undefined, name: string): Record<string, { add?: string[]; remove?: string[] }> {
  const t = (raw ?? '').trim();
  if (!t) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(t); } catch { throw new ConfigError(`${name} is not valid JSON`); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new ConfigError(`${name} must be a JSON object`);
  const isStringArray = (x: unknown): x is string[] => Array.isArray(x) && x.every((e) => typeof e === 'string');
  const out: Record<string, { add?: string[]; remove?: string[] }> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    const isObj = v !== null && typeof v === 'object' && !Array.isArray(v);
    const e = isObj ? (v as Record<string, unknown>) : undefined;
    if (!isObj || (e!.add !== undefined && !isStringArray(e!.add)) || (e!.remove !== undefined && !isStringArray(e!.remove))) {
      throw new ConfigError(`${name} entries must be objects with optional string[] add/remove`);
    }
    // A misspelled key, or a value in BOTH add and remove, would otherwise parse cleanly and quietly
    // block nothing — failing OPEN, the wrong direction for a parser whose errors become a 403.
    const unknown = Object.keys(e!).filter((x) => x !== 'add' && x !== 'remove');
    if (unknown.length) throw new ConfigError(`${name} entry "${k}" has unknown key(s): ${unknown.join(', ')}`);
    const add = (e!.add as string[] | undefined)?.map((x) => x.trim());
    const remove = (e!.remove as string[] | undefined)?.map((x) => x.trim());
    const both = (add ?? []).filter((x) => (remove ?? []).includes(x));
    if (both.length) throw new ConfigError(`${name} entry "${k}" lists ${both.join(', ')} in both add and remove`);
    out[k.toLowerCase()] = { ...(add ? { add } : {}), ...(remove ? { remove } : {}) };
  }
  return out;
}

/**
 * Is this extension barred from gaining a device on this domain? Resolves the global blocklist, applies
 * the domain's `add` then `remove`, and matches with prefix-wildcard support (`90*`). Callers use it to
 * refuse provision/heal and to skip repair — never to refuse a login, since blocking device CREATION
 * shouldn't disconnect an extension that already works.
 */
const extMatches = (ext: string, patterns: string[]): boolean =>
  patterns.some((p) => {
    const t = p.trim();
    return t.endsWith('*') ? ext.startsWith(t.slice(0, -1)) : ext === t;
  });

export function extBlocked(ext: string, domain: string, config: Pick<Config, 'blockExts' | 'blockExtsByDomain'>): boolean {
  const dom = config.blockExtsByDomain[domain.toLowerCase()] ?? {};
  const e = ext.trim();
  // `remove` is evaluated with the SAME wildcard matching as the block list, not as set subtraction.
  // Deleting the literal string would make the two headline features silently incompatible: a global
  // `90*` with a per-domain `remove: ["900"]` would delete nothing, leaving 900 blocked on the very
  // domain meant to be exempt — no error, no log, just denied logins.
  if (extMatches(e, dom.remove ?? [])) return false;
  return extMatches(e, [...config.blockExts, ...(dom.add ?? [])]);
}

/**
 * Is `domain` permitted by an allow/block pair? **Block always wins**, so the intended shape is a broad
 * allowlist (often `*`) narrowed by a short blocklist, rather than enumerating every permitted domain.
 * An empty blocklist blocks nothing; an empty allowlist permits nothing.
 */
export function domainAllowed(allow: string[] | '*', block: string[] | '*', domain: string): boolean {
  return domainInList(allow, domain) && !domainInList(block, domain);
}

export function domainInList(list: string[] | '*', domain: string): boolean {
  return list === '*' ? true : list.includes(domain.toLowerCase());
}

const SOFT_CATS: readonly SoftCategory[] = ['names', 'exts', 'no_devices'];

function parseEligibility(env: Env): EligibilityConfig {
  // Seeded soft-exclusion name matchers. SUBSTRING, case-insensitive — so 'GENERAL' already covers
  // 'GENERAL VOICEMAIL', and 'VOICEMAIL' subsumes 'SHARED VOICEMAIL' — the longer form is kept only
  // to show that a more specific matcher can be listed. 'CONFERENCE' is spelled out deliberately — bare 'CONF' would also match
  // surnames — with 'CONF RM'/'CONF ROOM' added for the abbreviated forms it therefore misses.
  // Soft means
  // reseller-overridable and creation-only: an existing user is never blocked from signing in.
  const rawNames = env.RINGOTEL_EXCLUDE_NAMES !== undefined ? csv(env.RINGOTEL_EXCLUDE_NAMES) : ['SHARED', 'SHARED VOICEMAIL', 'VOICEMAIL', 'FAX', 'GENERAL', 'CONFERENCE', 'CONF RM', 'CONF ROOM', 'ROUTING'];
  const excludeNames = rawNames.map((n) => n.toLowerCase());

  let excludeExtsByDomain: EligibilityConfig['excludeExtsByDomain'];
  excludeExtsByDomain = parseByDomain(env.RINGOTEL_EXCLUDE_EXTS_BY_DOMAIN, 'RINGOTEL_EXCLUDE_EXTS_BY_DOMAIN');

  return {
    excludeNames,
    excludeExts: csv(env.RINGOTEL_EXCLUDE_EXTS),
    excludeExtsByDomain,
    // Always false. The library's no-device rule only NARROWS the name exclusion, and only when a
    // device count is supplied — this Worker deliberately never fetches one (it would cost an
    // admin-identity call per login purely to feed a heuristic), so the setting could not do anything.
    excludeNoDevices: false,
    // Always empty here. `evaluateEligibility` consults this only when `isReseller` is true, and both
    // call sites pass false by design: an SSO login is an end user authenticating themselves, so there
    // is no reseller in the request, and trusting a caller's claim to be one would be exactly the
    // escalation this Worker's identity handling exists to prevent. Nothing is lost — soft exclusions
    // block CREATION only, so a reseller override performed in a companion portal yields a real Ringotel
    // record, which this Worker then classifies as active and signs in normally.
    resellerOverride: new Set<SoftCategory>(),
  };
}

function parseMapping(env: Env): MappingConfig {
  const raw = (env.SSO_DOMAIN_MAP ?? '').trim();
  if (!raw) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new ConfigError('SSO_DOMAIN_MAP is not valid JSON'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new ConfigError('SSO_DOMAIN_MAP must be a JSON object of firstLabel→orgKey');
  for (const v of Object.values(parsed as Record<string, unknown>)) {
    if (typeof v !== 'string') throw new ConfigError('SSO_DOMAIN_MAP values must be strings (firstLabel→orgKey)');
  }
  // (M5) Lowercase the rule `match` keys so they line up with the lowercased first label orgBranch.ts
  // resolves the domain to, regardless of the case an operator writes SSO_DOMAIN_MAP in.
  const rules = Object.entries(parsed as Record<string, string>).map(([match, to]) => ({ match: match.toLowerCase(), to }));
  return { rules };
}

function parseWriteIdentity(env: Env): WriteIdentity {
  const user = (env.NS_ADMIN_USER ?? '').trim();
  const pass = (env.NS_ADMIN_PASS ?? '').trim();
  const token = (env.NS_API_KEY ?? '').trim();
  if (user && pass) return { kind: 'admin', user, pass };
  if (token) return { kind: 'api', token };
  throw new ConfigError('a write identity is required: set NS_ADMIN_USER + NS_ADMIN_PASS, or NS_API_KEY');
}

export function parseConfig(env: Env): Config {
  const nsServer = req(env.NS_SERVER, 'NS_SERVER');
  let suffix = 'r';
  if (env.DEVICE_SUFFIX !== undefined) {
    suffix = env.DEVICE_SUFFIX.trim();
    if (!suffix) throw new ConfigError('DEVICE_SUFFIX must not be blank');
  }
  return {
    basicUser: req(env.SSO_BASIC_USER, 'SSO_BASIC_USER'),
    basicPassword: req(env.SSO_BASIC_PASSWORD, 'SSO_BASIC_PASSWORD'),
    nsServer,
    nsOauthServer: (env.NS_OAUTH_SERVER ?? '').trim() || nsServer,
    oauthClientId: req(env.NS_OAUTH_CLIENT_ID, 'NS_OAUTH_CLIENT_ID'),
    oauthClientSecret: req(env.NS_OAUTH_CLIENT_SECRET, 'NS_OAUTH_CLIENT_SECRET'),
    writeIdentity: parseWriteIdentity(env),
    ringotelToken: req(env.RINGOTEL_API_KEY, 'RINGOTEL_API_KEY'),
    suffix,
    healDomains: parseList(env.SSO_HEAL_DOMAINS),
    provisionDomains: parseList(env.SSO_PROVISION_DOMAINS),
    repairDomains: parseList(env.SSO_REPAIR_DOMAINS),
    blockDomains: parseList(env.SSO_BLOCK_DOMAINS),
    healBlockDomains: parseList(env.SSO_HEAL_BLOCK_DOMAINS),
    provisionBlockDomains: parseList(env.SSO_PROVISION_BLOCK_DOMAINS),
    repairBlockDomains: parseList(env.SSO_REPAIR_BLOCK_DOMAINS),
    paths: parsePaths(env.SSO_PATHS),
    blockExts: csv(env.SSO_BLOCK_EXTS),
    blockExtsByDomain: parseByDomain(env.SSO_BLOCK_EXTS_BY_DOMAIN, 'SSO_BLOCK_EXTS_BY_DOMAIN'),
    sendActivationEmail: truthy(env.SSO_SEND_ACTIVATION_EMAIL),
    requireEmail: parseRequireEmail(env.SSO_REQUIRE_EMAIL),
    eligibility: parseEligibility(env),
    mapping: parseMapping(env),
  };
}

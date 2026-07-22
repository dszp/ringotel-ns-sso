import { resolveCanonicalUser, type User, type Rec, type RingotelWriteClient } from '@dszp/ringotel-lib';
import { evaluateEligibility, type EligUser } from '@dszp/netsapiens-lib';
import type { Config } from './config.js';
import { resolveOrgBranch, resolveNsDomainByRtDomain, type OrgBranch, type OrgBranchReader } from './orgBranch.js';
import { parseLogin, loginCandidates, domainClaimMatches } from './login.js';
import { modeFor, decide, healPermitted } from './decide.js';
import { domainInList, domainAllowed, extBlocked } from './config.js';
import type { RepairTask } from './repair.js';

/** NS device field carrying the auto-generated SIP registration password (v2). */
export const SIP_PW_FIELD = 'device-sip-registration-password';

/**
 * `domain` is OPTIONAL and, when sent, is the **Ringotel organization domain** — the value the app's
 * sign-in screen asks for. Ringotel does not know the NetSapiens domain and can never send it.
 *
 * It does two jobs, neither of which makes it identity:
 *  - **Backfill.** A username of a bare extension is meaningless on its own, so the org domain is looked
 *    up to find which NetSapiens domain it belongs to, and the NS login is built from that. The caller's
 *    value only ever selects *which credentials get checked* — the check itself still has to pass.
 *  - **Cross-tenant guard.** After authentication it must name the tenant the authenticated user
 *    actually belongs to (as its Ringotel domain, the NS domain, or that domain's first label), or the
 *    login is refused before any write.
 *
 * After authentication the NS self-record remains the sole source of extension and domain, exactly as
 * before. A `username` that already carries a domain (`1045@acme`) needs neither job and is used verbatim.
 */
export interface AuthorizeInput { username: string; password: string; domain?: string }

interface WriteNs {
  getDevices(domain: string, user: string): Promise<Rec[]>;
  getDevice(domain: string, user: string, device: string): Promise<Rec>;
  createDevice(domain: string, user: string, device: string): Promise<Rec>;
}

export interface AuthorizeDeps {
  config: Config;
  /** Authenticate against NS with the CALLER's own credentials and return NS's self-record for that
   *  user (GET /domains/~/users/~ with the user's own token) — never the caller-supplied domain, and
   *  never an admin-token read. `self` is the sole source of truth for extension/domain/eligibility. */
  auth: { authenticate(username: string, password: string): Promise<{ ok: boolean; self?: Rec }> };
  read: OrgBranchReader & { getUsers(orgid: string, branchid?: string): Promise<User[]> };
  getWrite: () => Promise<{ rt: Pick<RingotelWriteClient, 'createUser' | 'updateUser' | 'deleteUser'>; ns: WriteNs }>;
}

export interface AuthorizeResult {
  status: 200 | 403;
  /** `domain` here is the RINGOTEL org domain (what Ringotel's SSO `response_map` consumes to bind the
   *  session) — NOT the NetSapiens domain. See the `rtDomain` computation below `success`. */
  body?: { extension: string; authname: string; domain: string };
  /**
   * Post-response housekeeping for the caller to run via `ctx.waitUntil` — present only on an `allow`
   * for a domain in SSO_REPAIR_DOMAINS. Never set for heal/provision: those paths already wrote the
   * device and pushed the password during the request.
   */
  repair?: RepairTask;
  log: Record<string, unknown>;
}

const str = (v: unknown): string => (v == null ? '' : String(v)).trim();

/**
 * First non-blank email across the likely v2 NS field spellings (mirrors the companion portal's `worker.ts`
 * `firstEmail`). A value that's an array is walked for its first non-blank element — NS does not
 * delimit multiple addresses with commas/semicolons (confirmed live), so no further splitting is done.
 */
function firstEmail(u: Rec): string {
  for (const k of ['email', 'email-address', 'email_address', 'emailaddress']) {
    const v = u[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (Array.isArray(v)) for (const e of v) if (typeof e === 'string' && e.trim()) return e.trim();
  }
  return '';
}

/**
 * The system/service-user marker; NS spells it several ways across v1/v2 (mirrors the companion portal's
 * `nsUserToElig` `??` order). `service-code` is the live-verified v2 field name (as of 2026-07-19);
 * `srv_code`/`srv-code` are legacy fallbacks. (M2) A non-string value (e.g. a number) must still HARD-block
 * rather than silently becoming `undefined` — coerce via `String()` before the blank check.
 */
function srvCode(u: Rec): string | undefined {
  const raw = u['srv_code'] ?? u['srv-code'] ?? u['service-code'];
  return raw != null ? (String(raw).trim() || undefined) : undefined;
}

// (F3) The following three helpers share ONE spelling chain per name part, so the display-name pushed to
// Ringotel and the `names` list checked by eligibility's soft SHARED/FAX exclusion can never drift apart
// — a record that carries its name only under an alternate spelling must be caught by both.
function nsFirstName(u: Rec): string {
  return str(u['first-name'] ?? u['first_name'] ?? u['name-first-name']);
}
function nsLastName(u: Rec): string {
  return str(u['last-name'] ?? u['last_name'] ?? u['name-last-name']);
}
function nsExplicitDisplayName(u: Rec): string {
  return str(u['display-name'] ?? u['name-full-name']);
}

/**
 * The single display name to push into Ringotel for an NS user: `First Last` when either part exists,
 * else an explicit display-name field (mirrors the companion portal's `nsDisplayName`). Caller falls back to
 * the extension when this is blank.
 */
function nsDisplayName(u: Rec): string {
  const first = nsFirstName(u);
  const last = nsLastName(u);
  const full = [first, last].filter(Boolean).join(' ').trim();
  return full || nsExplicitDisplayName(u);
}

/**
 * (F3) Every distinct name string worth checking against eligibility's soft name-exclusion list — first,
 * last, AND the resolved display name (which alone catches an explicit `display-name`/`name-full-name`
 * field when first/last are both blank). Built from the exact same spelling chains as `nsDisplayName`
 * above, so the two can't drift.
 */
function nsEligibilityNames(u: Rec): string[] {
  return [nsFirstName(u), nsLastName(u), nsDisplayName(u)].filter(Boolean);
}

/** Build the `EligUser` eligibility input from the NS self-record, shared by the provision-create
 *  eligibility check and the heal-time HARD gate (M8) so they can't diverge either. */
function toEligUser(self: Rec, ext: string, email: string): EligUser {
  return { ext, srvCode: srvCode(self), email: email || undefined, names: nsEligibilityNames(self), deviceCount: undefined };
}

/** Ensure the NS softphone device exists; return its SIP password. */
async function ensureDevice(ns: WriteNs, domain: string, ext: string, device: string, mayCreate = true): Promise<string> {
  const devices = await ns.getDevices(domain, ext);
  const existing = devices.find((d) => String(d.device ?? '') === device);
  if (existing) {
    const dev = await ns.getDevice(domain, ext, device);
    return String(dev[SIP_PW_FIELD] ?? existing[SIP_PW_FIELD] ?? '');
  }
  // `mayCreate: false` is how a blocked extension still gets healed when healing needs no new device:
  // an empty return propagates to the caller's existing blank-password guard, which denies.
  if (!mayCreate) return '';
  const created = await ns.createDevice(domain, ext, device);
  return String(created[SIP_PW_FIELD] ?? '');
}

/**
 * Memoize the two Ringotel reads for the life of one request. The reverse domain lookup and
 * `resolveOrgBranch` both need the org list, and both need the branches of the org they land on — without
 * this, a backfilled login pays for each of them twice. Nothing is cached across requests: a stale org
 * list would resolve a login into a tenant that has since moved.
 */
function memoReader(read: OrgBranchReader): OrgBranchReader {
  let orgs: Promise<Rec[]> | undefined;
  const branches = new Map<string, Promise<Rec[]>>();
  return {
    getOrganizations: () => (orgs ??= read.getOrganizations()),
    getBranches: (orgid: string) => {
      const hit = branches.get(orgid);
      if (hit) return hit;
      const p = read.getBranches(orgid);
      branches.set(orgid, p);
      return p;
    },
  };
}

export async function authorize(input: AuthorizeInput, deps: AuthorizeDeps): Promise<AuthorizeResult> {
  const { config } = deps;
  const log: Record<string, unknown> = { domain: input.domain };
  const read = memoReader(deps.read);

  // Memoized helper: mint the write client at most once (heal/provision device work + provision-create
  // both need it — see below).
  let _write: Awaited<ReturnType<typeof deps.getWrite>> | undefined;
  const getWrite = async () => (_write ??= await deps.getWrite());

  // 0. Work out WHICH NetSapiens username to check. A username that already carries a domain
  // (`1045@acme`) is used verbatim — the original and still the common case. A bare extension is not a
  // username at all until a tenant is known, and the only tenant hint a Ringotel client can send is its
  // own ORG domain, so that is resolved back to a NetSapiens domain first.
  //
  // This is the one step that touches Ringotel before any credential has been checked. It reads only,
  // and its result decides which credentials get verified — never who the caller turns out to be.
  const parsed = parseLogin(input.username);
  let logins: string[];
  // The NS domain the caller's claimed org domain was resolved TO, when it was resolved at all. It is
  // the strongest form of the cross-tenant check: not "these two strings look like the same tenant" but
  // "the tenant they named is the tenant they authenticated into".
  let claimedNsDomain: string | undefined;
  if (parsed.label) {
    logins = [input.username.trim()];
    log.loginForm = 'verbatim';
  } else {
    // No tenant in the username and none supplied ⇒ refuse here, before spending an NS call. An
    // extension is not globally unique, so any guess would be a guess about whose account to open.
    if (!input.domain) return { status: 403, log: { ...log, outcome: 'deny', reason: 'no-domain-hint' } };
    const want = input.domain.trim().toLowerCase();
    const mapped = config.rtDomainMap[want];
    let nsDomain: string;
    if (mapped) {
      nsDomain = mapped;
      log.rtDomainSource = 'map';
    } else {
      const found = await resolveNsDomainByRtDomain(read, want);
      if (!found.ok) {
        // Reported distinctly: 'ambiguous' means the Ringotel domain answers for more than one branch
        // address, which SSO_RT_DOMAIN_MAP fixes; 'not-found' means no org carries that domain at all.
        const reason = found.reason === 'ambiguous' ? 'ambiguous-org-domain' : 'unknown-org-domain';
        return { status: 403, log: { ...log, outcome: 'deny', reason } };
      }
      nsDomain = found.nsDomain;
      log.rtDomainSource = 'lookup';
    }
    log.resolvedNsDomain = nsDomain;
    claimedNsDomain = nsDomain;
    logins = loginCandidates(parsed.ext, nsDomain, config.loginForm);
    log.loginForm = config.loginForm;
  }

  // 1. Authenticate with the CALLER's own credentials. This mints the user's own NS access token and
  // reads their self-record (GET /domains/~/users/~ with that token) — never an admin-token lookup, and
  // never anything derived from the caller-supplied `input.domain` beyond WHICH username was offered.
  // A bad login is rejected before any further Ringotel or org-branch call is made.
  //
  // At most two spellings are tried, and only for a backfilled username (see loginCandidates): each
  // wrong attempt is a failed grant, and failed grants count against the core's lockout policy.
  let a: { ok: boolean; self?: Rec } = { ok: false };
  for (const candidate of logins) {
    a = await deps.auth.authenticate(candidate, input.password);
    if (a.ok && a.self) { log.loginUsed = candidate; break; }
  }
  if (!a.ok || !a.self) return { status: 403, log: { ...log, outcome: 'deny', reason: 'bad-credentials' } };
  const self = a.self;

  const ext = String(self.user ?? '').trim();
  if (!ext) return { status: 403, log: { ...log, outcome: 'deny', reason: 'no-extension' } };
  log.ext = ext;

  // The AUTHORITATIVE domain comes from NS's self-record, never from the caller-supplied `input.domain`.
  const domain = String(self.domain ?? '').trim();
  if (!domain) return { status: 403, log: { ...log, outcome: 'deny', reason: 'no-domain' } };
  log.domain = domain;

  // Domain blocklist — refuse outright, before mode selection, org/branch resolution, or any Ringotel
  // call. This necessarily runs AFTER the NetSapiens credential check, because `domain` comes from the
  // user's own self-record and never from caller input: a blocked user is authenticated first, then
  // refused. That ordering is deliberate — identity is never taken from the request.
  if (domainInList(config.blockDomains, domain)) {
    return { status: 403, log: { ...log, outcome: 'deny', reason: 'domain-blocked' } };
  }

  // Cross-tenant guard: only runs when the caller actually supplied a `domain`. When present it must
  // name THIS user's tenant — otherwise a valid credential in one domain could be used to operate on
  // another domain's org/branch. When absent, there is nothing to cross-check; proceed using the
  // self-derived `domain` alone, which is (and always was) the sole source of identity.
  //
  // Ringotel sends its own ORG domain, which is not knowable from the NetSapiens record alone — it comes
  // out of `resolveOrgBranch` below. So the guard is settled in two stages: a NetSapiens-shaped claim is
  // accepted here, and anything else is carried forward and decided the moment the org is resolved,
  // still well before any write or any 200.
  let claimPending = false;
  if (input.domain) {
    if (claimedNsDomain && claimedNsDomain.toLowerCase() === domain.toLowerCase()) {
      // The claim was resolved to a NetSapiens domain before authentication, and that is the domain the
      // credentials turned out to belong to. Nothing about the Ringotel-side spelling need be compared.
      log.domainCheck = 'ok-resolved';
    } else if (domainClaimMatches(input.domain, { nsDomain: domain })) {
      log.domainCheck = 'ok';
    } else {
      claimPending = true;
    }
  } else {
    log.domainCheck = 'skipped-not-supplied';
  }

  // NS identity, computed once from `self` (never an admin-token NS read) — reused below for
  // eligibility, the heal identity-sync, and provision-create.
  const name = nsDisplayName(self) || ext;
  const email = firstEmail(self);

  // 2. Resolve org/branch (authoritative address match).
  const ob: OrgBranch | null = await resolveOrgBranch(read, domain, config.mapping);
  if (!ob) return { status: 403, log: { ...log, outcome: 'deny', reason: 'no-org-branch' } };

  // Stage two of the cross-tenant guard (see above): the claim was not a NetSapiens spelling, so it has
  // to be this tenant's RINGOTEL domain — the form Ringotel actually sends. Nothing has been written and
  // no Ringotel user has been read at this point, so a refusal here is as clean as one before the org
  // lookup; it simply could not be answered any earlier.
  if (claimPending) {
    if (!domainClaimMatches(input.domain!, { nsDomain: domain, rtDomain: ob.rtDomain })) {
      return { status: 403, log: { ...log, outcome: 'deny', reason: 'domain-mismatch' } };
    }
    log.domainCheck = 'ok-rt';
  }

  // 3. Read + classify the Ringotel records at this extension.
  const users = await deps.read.getUsers(ob.orgid, ob.branchid);
  const res = resolveCanonicalUser(users, { ext, branchid: ob.branchid, suffix: config.suffix });
  const mode = modeFor(domain, {
    heal: config.healDomains,
    provision: config.provisionDomains,
    healBlock: config.healBlockDomains,
    provisionBlock: config.provisionBlockDomains,
  });
  log.verdict = res.verdict;
  log.mode = mode;

  // 4. Eligibility is only needed to decide a fresh CREATE (verdict 'none' on a provision domain).
  // Built directly from `self` (the user's own self-endpoint read) — NO admin-token user fetch.
  // deviceCount is left undefined: the no-device heuristic in evaluateEligibility is default-off, and
  // we deliberately don't spend an extra admin-identity call just to populate it.
  let eligible = true;
  if (res.verdict === 'none' && mode === 'provision') {
    const eu = toEligUser(self, ext, email);
    // The email precondition exists because activation traditionally emails the credentials — it is a
    // "somewhere to send them" check, not a policy about who deserves an app. When we are NOT sending
    // that email, the reason evaporates, so `auto` waives it. `always` keeps it (some operators use a
    // missing address as a deliberate marker for staff who shouldn't get an app login); `never` drops it.
    // Still deliberately narrow: `emailNotRequired` waives ONLY the email check inside the library, so a
    // future precondition added there is not silently bypassed along with it. The waiver used to be
    // re-implemented here on top of the result; it now rides the shared engine, so this Worker and the
    // portal produce the same verdict from the same inputs.
    const mustHaveEmail =
      config.requireEmail === 'always' || (config.requireEmail === 'auto' && config.sendActivationEmail);
    // (M5) Lowercase the domain passed into eligibility so it matches the lowercased
    // `excludeExtsByDomain` keys parsed in config.ts — case can't desync the per-domain override lookup.
    const elig = evaluateEligibility(
      eu,
      { domain: domain.toLowerCase(), isReseller: false, emailNotRequired: !mustHaveEmail },
      config.eligibility,
    );
    eligible = elig.activatable;
    log.eligibility = elig.tier;
    // `emailWaived` means: eligible, but there is no address — so nothing may be mailed to this user.
    if (elig.emailWaived) log.emailPrecondition = 'waived';
  }

  // 5. Decide.
  // Heal permission is asked separately from mode: `provision` mode also heals (an inactive or
  // duplicated record is reactivated, not created), so a heal-blocked domain would otherwise still be
  // healed on any provision-enabled deployment.
  const canHeal = healPermitted(domain, { heal: config.healDomains, healBlock: config.healBlockDomains });
  const decision = decide(res.verdict, mode, eligible, canHeal);

  // Extension blocklist — refuses every path that would CREATE a device (provision, heal, and the
  // post-response repair below), independently of the domain's mode. Deliberately does NOT refuse the
  // login: barring device creation shouldn't disconnect an extension that already has a working record.
  const blockedExt = extBlocked(ext, domain, config);
  if (blockedExt) log.extBlocked = true;
  // Provisioning always creates a device, so a blocked extension is refused outright. HEAL is not
  // refused here: it is also the action for an `ambiguous` verdict, where a healthy user with a
  // tombstone sibling needs only a dedup — no device. Blocking that would deny a working login, which
  // this feature explicitly promises not to do. Heal instead runs with device CREATION disabled below,
  // and denies only if it turns out a device would have been needed.
  if (blockedExt && decision.action === 'provision') {
    log.action = decision.action;
    return { status: 403, log: { ...log, outcome: 'deny', reason: 'ext-blocked' } };
  }
  log.action = decision.action;
  log.decisionReason = decision.reason;

  // The HTTP success body's `domain` is the Ringotel org domain (what Ringotel's SSO `response_map`
  // consumes to bind the session) — NOT the NetSapiens domain used everywhere else above (mode
  // selection, resolveOrgBranch, eligibility, the cross-tenant check) and below (createUser's `domain`,
  // which is the NS domain the Ringotel user's SIP identity belongs to). If neither the branch nor the
  // org carries a Ringotel domain, fall back to the NS domain so the field is never empty, and flag it.
  const rtDomain = ob.rtDomain || domain;
  if (!ob.rtDomain) log.rtDomainFallback = true;
  log.rtDomain = rtDomain;

  // `allow` returns the canonical record's real authname (resolveCanonicalUser's active verdict only checks
  // status===1, not SIP identity, so a legacy/renamed active record could otherwise get a 200 with a wrong
  // authname); heal/provision return ext+suffix, which is what they just wrote.
  const success = (authname: string): AuthorizeResult => ({
    status: 200,
    body: { extension: ext, authname, domain: rtDomain },
    log: { ...log, outcome: 'allow' },
  });

  if (decision.action === 'deny') return { status: 403, log: { ...log, outcome: 'deny', reason: decision.reason } };
  if (decision.action === 'allow') {
    const authname = String(res.user?.authname ?? ext + config.suffix);
    const out = success(authname);
    // An `allow` performs no writes, so a deleted upstream device is invisible here — schedule the check
    // for after the response. Requires a resolved record id: without one there is nothing to update.
    if (res.user?.id && !blockedExt && domainAllowed(config.repairDomains, config.repairBlockDomains, domain)) {
      out.repair = {
        domain,
        ext,
        device: ext + config.suffix,
        orgid: ob.orgid,
        userId: String(res.user.id),
        // RAW value, deliberately WITHOUT the `ext + config.suffix` fallback used for the HTTP body
        // above: `??` only fires on null/undefined, so a record with a genuinely MISSING `authname`
        // field would otherwise be substituted with the exact value `runDeviceRepair`'s drift gate
        // expects — making the gate pass having verified nothing, against the single most dangerous
        // target (an active record with no SIP identity at all). An absent field must yield `''` here
        // so it fails the `task.authname !== task.device` check and the repair is safely skipped
        // (logged `skipped-authname-drift`), not fall through as a false match.
        authname: String(res.user?.authname ?? ''),
      };
    }
    return out;
  }

  const device = ext + config.suffix;

  if (decision.action === 'heal') {
    if (!res.user) return { status: 403, log: { ...log, outcome: 'deny', reason: 'ambiguous-unpickable' } };

    // (M8) HARD eligibility gate applies to heal too: a system/service user with a pre-existing
    // deactivated Ringotel record on a heal domain must NOT be reactivated (and billed). Only the HARD
    // tier blocks here — soft (name/ext) and precondition (email) tiers gate CREATION only, not healing
    // an already-provisioned record.
    const eu = toEligUser(self, ext, email);
    const elig = evaluateEligibility(eu, { domain: domain.toLowerCase(), isReseller: false }, config.eligibility);
    if (elig.tier === 'hard') {
      log.eligibility = elig.tier;
      return { status: 403, log: { ...log, outcome: 'deny', reason: 'ineligible-hard' } };
    }

    const { rt, ns } = await getWrite();
    const password = await ensureDevice(ns, domain, ext, device, !blockedExt);
    // (M1) Never write a blank SIP password into Ringotel: on heal this would overwrite a working
    // password on the canonical record with an empty one. Fail closed BEFORE any Ringotel write.
    // For a blocked extension the blank also means "the device is missing and we refused to create it".
    if (!password) {
      return { status: 403, log: { ...log, outcome: 'deny', reason: blockedExt ? 'ext-blocked' : 'no-sip-password' } };
    }

    // (F1) Activate the canonical FIRST, then best-effort delete the non-canonical siblings — reordered
    // from "dedup siblings → ensureDevice → activate" to close the brick window: if siblings are deleted
    // before the canonical is reactivated with the SIP identity, an SSO bind that lands in that gap can
    // permanently brick the extension (NS "Invalid User ID", un-editable/un-deletable). This order is
    // provably collision-free: resolveCanonicalUser picks whichever record already carries the SIP
    // identity `<ext><suffix>` (username/authname) as canonical; a NON-canonical sibling therefore never
    // holds that identity, so writing it onto the canonical here can't clash with a surviving sibling —
    // it's a no-op if the canonical already had it, or a takeover of an identity no sibling claims.
    // NetSapiens is the source of truth for identity, so `email` is synced FAITHFULLY — including when it
    // is blank. An address removed in NetSapiens is a real change and must propagate; preserving a stale
    // Ringotel address because the authoritative record no longer has one would make the directory quietly
    // disagree with the platform it mirrors. (Note the companion portal's `activate()` guards instead, only
    // sending a non-empty address — a deliberate divergence, see that repo's HANDOFF.)
    await rt.updateUser(String(res.user.id), ob.orgid, {
      status: 1, username: device, authname: device, password, name, email,
      noemail: !config.sendActivationEmail,
    });

    const dedupFailures: string[] = [];
    for (const m of res.matches) {
      if (m.id === res.user.id) continue;
      try {
        await rt.deleteUser(String(m.id), ob.orgid);
      } catch {
        // un-deletable phantom must not block the heal, but record it so it's visible in logs.
        dedupFailures.push(String(m.id));
      }
    }
    if (dedupFailures.length) log.dedupFailures = dedupFailures;
    return success(device);
  }

  // provision (create) — name/email come from `self`, not an admin-token NS read.
  {
    const { rt, ns } = await getWrite();
    const password = await ensureDevice(ns, domain, ext, device);
    // (M1) Same blank-password guard as heal, before any Ringotel write.
    if (!password) return { status: 403, log: { ...log, outcome: 'deny', reason: 'no-sip-password' } };
    await rt.createUser({
      orgid: ob.orgid, branchid: ob.branchid, name, extension: ext, domain,
      username: device, authname: device, password, email, status: 1, noemail: !config.sendActivationEmail,
    });
    return success(device);
  }
}

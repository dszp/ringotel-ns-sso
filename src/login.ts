/**
 * Turning what the user typed into the username NetSapiens will actually accept.
 *
 * Ringotel's sign-in screen asks for an **organization domain** plus a username and password. The org
 * domain is a Ringotel value — Ringotel does not know the NetSapiens domain and can never send it. So a
 * user may type either form of username:
 *
 *   `1045@acme`  — already carries the tenant; used verbatim, as it always has been
 *   `1045`       — an extension alone, which identifies nobody until the org domain is resolved
 *
 * NetSapiens matches the stored unique `login-username`, which on every deployment observed is the SHORT
 * form (`<ext>@<first label>`), not the full `<ext>@<domain>.<reseller>.service`. Both are tried in
 * `auto` (the default) because "observed" is not "guaranteed" — an operator whose core stores the full
 * form would otherwise be unable to use this at all.
 */

/** How a backfilled username is spelled. `auto` = short form, then full on failure. */
export type LoginForm = 'auto' | 'short' | 'full';

export interface ParsedLogin {
  /** Everything before the last `@`, or the whole value when there is none. */
  ext: string;
  /** The domain label the user typed, if any. Its presence is what makes a lookup unnecessary. */
  label?: string;
}

/**
 * Split what the user typed. The LAST `@` wins: an extension cannot contain one, and if a deployment
 * ever stores an email-shaped login the tenant is still the trailing part.
 */
export function parseLogin(username: string): ParsedLogin {
  const raw = username.trim();
  const at = raw.lastIndexOf('@');
  if (at <= 0 || at === raw.length - 1) return { ext: raw };
  return { ext: raw.slice(0, at), label: raw.slice(at + 1) };
}

/** The first label of a NetSapiens domain — `acme.12345.service` → `acme`. */
export const firstLabel = (domain: string): string => (domain.split('.')[0] ?? domain).trim();

/**
 * The username spellings to try, in order, for an extension backfilled from a resolved NS domain.
 *
 * Deliberately at most two. Each attempt is a failed password grant when it is wrong, and failed grants
 * count against whatever lockout policy the NetSapiens core enforces — so a user who mistypes their
 * password should not burn three attempts to discover it. `short` or `full` pins a single spelling for
 * deployments that know which one their core stores and would rather spend nothing on the other.
 */
export function loginCandidates(ext: string, nsDomain: string, form: LoginForm = 'auto'): string[] {
  // No extension ⇒ no candidates. `@acme` and a whitespace username both parse as "bare" (correctly —
  // neither carries a usable tenant), and concatenating them produced logins like `@acme` that could
  // only ever fail, at the cost of two real grant attempts.
  if (!ext.trim() || !nsDomain.trim()) return [];
  const short = `${ext}@${firstLabel(nsDomain)}`;
  const full = `${ext}@${nsDomain}`;
  if (form === 'short') return [short];
  if (form === 'full') return [full];
  return short === full ? [short] : [short, full];
}

/**
 * Does the caller's claimed domain refer to this user's tenant?
 *
 * The claim arrives from Ringotel as its OWN org domain — the only value it has. It is compared against
 * every spelling of the same tenant we can name: the NetSapiens domain, its first label, and the
 * Ringotel org domain resolved for it. Accepting all three costs nothing (each is a value derived from
 * the authenticated user's own record, not from the caller) and means a proxy or a manual test that
 * sends a NetSapiens-shaped value is not rejected for being *more* specific than Ringotel can be.
 *
 * A claim matching none of them is a cross-tenant attempt or a misconfiguration; either way the caller
 * asked to operate on a tenant that is not this user's, and the login is refused.
 */
export function domainClaimMatches(claim: string, tenant: { nsDomain: string; rtDomain?: string }): boolean {
  const c = claim.trim().toLowerCase();
  if (!c) return true; // nothing claimed ⇒ nothing to contradict
  const ns = tenant.nsDomain.trim().toLowerCase();
  const forms = [ns, firstLabel(ns).toLowerCase()];
  if (tenant.rtDomain) forms.push(tenant.rtDomain.trim().toLowerCase());
  return forms.includes(c);
}

/**
 * A LOG-SAFE rendering of what the caller tried to sign in as.
 *
 * The operational question — "who is failing to log in, and against which tenant?" — needs the username,
 * and a failed login is exactly where it is worth having. But the username field is also where people
 * occasionally type their PASSWORD by mistake, and a password written into a searchable log store is a
 * much worse outcome than a missing diagnostic.
 *
 * So the two halves are treated differently:
 *  - the DOMAIN half is logged when it is DOMAIN-SHAPED. It names a tenant, not a person, and it is the
 *    signal that actually matters when a whole customer starts failing — but it cannot be exempt from
 *    checking: `p@$$w0rd` splits into ext `p` and "domain" `$$w0rd`, so a password containing an `@`
 *    would have written its own tail into the log verbatim. (Found by the test that asserted a
 *    password-shaped input is never recorded — it was, in the other half.)
 *  - the EXTENSION half is logged verbatim only when it is USERNAME-SHAPED: letters, digits, dot,
 *    underscore or hyphen, and short. Anything else is reduced to its shape — enough to see "somebody
 *    typed their email address" or "somebody is trying long random strings", and never the value.
 *
 * The shape test is what a password usually fails: symbols, spaces, punctuation, or length. It is a
 * filter, not a proof — a short all-alphanumeric password typed into the username field would still be
 * recorded. Tightening it further (rejecting mixed case with digits, say) starts rejecting real
 * usernames like `JohnDoe123`, which is the wrong trade for a diagnostic field. What is guaranteed is
 * that the PASSWORD field is never logged in any form, anywhere.
 */
const USERNAME_SHAPED = /^[A-Za-z0-9][A-Za-z0-9._-]{0,19}$/;
/** Hostname characters only. Deliberately allows a full NS domain (`acme.12345.service`). */
const DOMAIN_SHAPED = /^[A-Za-z0-9][A-Za-z0-9.-]{0,63}$/;

const shaped = (value: string, re: RegExp): string => (re.test(value) ? value : `other(len=${value.length})`);

export function logSafeAttempt(username: string): { ext: string; domain?: string } {
  const { ext, label } = parseLogin(username);
  return {
    ext: shaped(ext, USERNAME_SHAPED),
    ...(label ? { domain: shaped(label, DOMAIN_SHAPED) } : {}),
  };
}

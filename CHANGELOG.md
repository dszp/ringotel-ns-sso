# Changelog

All notable changes to `ringotel-ns-sso` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-07-22

### Added

- **Users can sign in with just their extension.** Ringotel's sign-in screen asks for an organization
  domain; when the SSO request carries it, a `username` of a bare extension (`101`) is resolved into the
  NetSapiens login it stands for, instead of being rejected as not a username. The organization domain is
  looked up against Ringotel's own org/branch data to find the NetSapiens domain bound to it, and the
  login is built from that — `<ext>@<first label>` first, then `<ext>@<full domain>`, configurable via
  `SSO_LOGIN_FORM`. `101@example` keeps working exactly as before and needs no lookup.

  This matters because **Ringotel does not know your NetSapiens domain and cannot send it** — the only
  tenant hint available is its own organization domain, so nothing else could turn an extension into a
  login. A bare extension with no organization domain is refused before any NetSapiens call: an extension
  is not globally unique, and any guess would be a guess about whose account to open.

  New: `SSO_RT_DOMAIN_MAP`, explicit organization-domain → NetSapiens-domain overrides, for a branch whose
  domain differs from its org's and for an organization domain that answers for more than one branch
  address (which the lookup refuses rather than resolving to a guess).

### Changed

- **The `domain` field in the request is now understood as the Ringotel organization domain.** It was
  previously compared only against the NetSapiens domain, so a request carrying Ringotel's own value —
  the one it is actually able to send — would have been refused as a cross-tenant attempt. The
  cross-tenant guard still refuses a value naming another tenant, before any write and before any Ringotel
  user is read; it now accepts the organization domain, the full NetSapiens domain, that domain's first
  label, or an `SSO_RT_DOMAIN_MAP` entry, since all of those name the same tenant. Accepting the first
  label does make two domains sharing one label indistinguishable *to the guard* — every read and write
  still uses the domain NetSapiens attached to the verified credential, so nothing downstream is affected.
  An organization with no Ringotel domain configured skips the check rather than denying, so enabling the
  field cannot become an outage for a tenant whose data could never have satisfied it.
- The per-account rate-limit key includes the organization domain when the username is a bare extension.
  A bare extension carries no tenant, so `101` from every domain would otherwise share one bucket and a
  busy tenant could throttle an unrelated one. Both halves are normalised, so casing or padding cannot
  split one account across buckets; note the domain half is caller-supplied, so two spellings that mean
  the same tenant are still two buckets.
- A branch address carrying a `:port` (a SIP destination, which a NetSapiens domain never is) resolves to
  the domain without it, instead of carrying the port into a login username or making one address look
  like two.

### Security

- **The Ringotel organization list is cached briefly** (`SSO_ORG_CACHE_TTL`, default 60s, `0` disables).
  Resolving a bare extension reads it before the caller's NetSapiens credentials are checked, so an
  unauthenticated flood could otherwise drive that read onto the Ringotel AdminAPI at request rate — and a
  throttled API key fails every login, not just the abusive ones. Branch and user reads stay live. The key
  is namespaced by a hash of the API token, so two Workers sharing a zone cannot read each other's fleet.
- The per-account rate-limit key is now normalised on both halves. Previously the caller-supplied domain
  half was not trimmed, so padding alone minted a fresh bucket per attempt against the same account.

## [0.1.3] - 2026-07-22

### Changed

- **The email-precondition waiver now rides the shared eligibility engine instead of being
  re-implemented here.** `@dszp/netsapiens-lib` 0.1.5 gained `EligContext.emailNotRequired`, so this
  worker passes the flag rather than overriding `activatable` after the call. Same rule, same narrow
  scope — only the email check is waived, so a precondition added to the library later is not silently
  bypassed with it — but the verdict is now produced by one implementation shared with the other
  consumer of that engine, which is the point: identical inputs can no longer yield different answers.
  `requireEmail` / `sendActivationEmail` still decide *when* the flag is passed; behavior is unchanged.
  Waiver logging keys off the library's `EligResult.emailWaived`.
- Requires `@dszp/netsapiens-lib` **^0.1.5**.

## [0.1.2] - 2026-07-20

### Fixed

- `SSO_BLOCK_EXTS_BY_DOMAIN`'s `remove` used exact-string subtraction while the block list matched with
  wildcards, so the two features silently didn't compose: a global `90*` with a per-domain
  `remove: ["900"]` left 900 blocked on the domain meant to be exempt — no error, no log, just denied
  logins. Both sides now use the same matcher, in either direction.
- A blocked extension was refused for the `heal` action outright. But `heal` is also the action for an
  `ambiguous` verdict — a healthy record beside a tombstone, needing only a de-duplication and no
  device — so a working user could be denied a login, which this feature explicitly promises not to do.
  Heal now runs with device creation disabled and denies only if a device would actually be required.
- A repair skipped because of the extension blocklist was logged identically to one skipped because the
  domain isn't repair-enabled. `extBlocked` is now recorded on every path.
- The per-domain override parser accepted unknown keys and the same value in both `add` and `remove`,
  both of which silently blocked nothing — failing open. Both are now startup errors.

### Changed

- Narrowed the seeded `GENERAL` matcher to `GENERAL VOICEMAIL` and `GENERAL MAILBOX`. Being a substring
  match, bare `GENERAL` also caught a staffed "General Manager" — and a soft exclusion at verdict `none`
  resolves to a denial, so the cost was a refused login for a real person rather than a skipped
  auto-create. Same reasoning that already ruled out bare `CONF`.

## [0.1.1] - 2026-07-20

### Added

- `SSO_BLOCK_EXTS` and `SSO_BLOCK_EXTS_BY_DOMAIN` — extensions that must never gain a softphone device.
  Unlike the soft `RINGOTEL_EXCLUDE_EXTS` rule, which gates auto-creation only and still permits heal and
  repair, this blocks **every** device-creating path. It does not refuse the login, so an extension that
  already has a working record keeps working. Prefix wildcards (`90*`) and per-domain `add`/`remove` are
  supported, so "blocked everywhere except one domain" is expressible.

### Changed

- Widened the seeded soft-exclusion name list used when `RINGOTEL_EXCLUDE_NAMES` is not set, to
  `SHARED`, `SHARED VOICEMAIL`, `VOICEMAIL`, `FAX`, `GENERAL VOICEMAIL`, `GENERAL MAILBOX`,
  `CONFERENCE`, `CONF RM`, `CONF ROOM`, `ROUTING` — the usual shapes of non-human extensions that
  shouldn't silently become billable app seats on first login.

  The matcher is substring and case-insensitive, which drives the choices: bare `VOICEMAIL` already
  subsumes the two longer voicemail entries, which are kept only to show that a more specific matcher
  can be listed. `CONFERENCE` is spelled out rather than `CONF`, which would also match surnames, with
  `CONF RM` and `CONF ROOM` covering the abbreviations it misses.

  These are **soft** exclusions: creation-only and overridable, so an existing user is never blocked
  from signing in. Set `RINGOTEL_EXCLUDE_NAMES` to replace the list, or to empty to disable name
  exclusions entirely.

## [0.1.0] - 2026-07-20

Initial release.

### Added

- **Ringotel SSO "authenticate" webhook for NetSapiens.** A Cloudflare Worker that verifies a login
  against NetSapiens and tells Ringotel whether to bind the session. `POST` (path configurable),
  Basic auth, `{username, password}` in — `domain` is accepted but optional — and
  `{extension, authname, domain}` or `403` out. `GET /health` is an unauthenticated liveness check.
- **Identity comes only from NetSapiens.** The end user's own credentials are verified with an OAuth
  password grant, and the extension and domain are then read from *their own* self-record
  (`GET /domains/~/users/~`) using *their own* token — never from the request body, and never with an
  administrative identity. A caller cannot act on a domain other than their own.
- **Fail-closed throughout.** Misconfiguration, malformed input, upstream errors and unexpected throws
  all deny. There is no path that returns a 500, and none that allows on error.
- **Four interventions, opted into per domain.** `validate` (default, never writes) allows a login only
  when a clean active record already exists; `heal` reactivates an inactive record and dedups duplicates;
  `provision` just-in-time creates and activates a missing one; and `repair` recreates a missing
  softphone device *after* the response is sent, so it never adds latency to a login. Each is gated by
  an allowlist (`*` / CSV / empty ⇒ off) paired with a blocklist that always wins, plus
  `SSO_BLOCK_DOMAINS` to refuse a domain's logins outright.
- **Pay on first login.** Provisioning means a Ringotel seat is created when someone actually signs in,
  rather than being bought in advance for users who never do.
- **Eligibility gates creation only.** System/service users and non-3–4-digit extensions can never be
  auto-created; name patterns and per-domain lists are configurable. `SSO_REQUIRE_EMAIL` decides whether
  an email address is a prerequisite, defaulting to "only when an activation email will be sent".
- **Silent by default.** `SSO_SEND_ACTIVATION_EMAIL` is off, because a user who arrived through SSO is
  already signed in and has no use for an emailed app password. Set it truthy to restore the email.
- **Two write-identity options** for device/user writes — `NS_ADMIN_USER` + `NS_ADMIN_PASS` (OAuth'd via
  the master key), or a static `NS_API_KEY`. An Office-Manager-scoped identity works for a
  single-domain deployment.
- **Runs behind a proxy or directly.** `SSO_PATHS` accepts a list, so one deployment can answer on both
  an existing webhook path and `/authorize` at once — moving traffic becomes a DNS change with an
  instant rollback rather than a coordinated cutover.
- Built entirely on the published [`@dszp/netsapiens-lib`](https://www.npmjs.com/package/@dszp/netsapiens-lib)
  and [`@dszp/ringotel-lib`](https://www.npmjs.com/package/@dszp/ringotel-lib) — no dependency on any
  private repository. This Worker owns composition and policy; the libraries own the primitives.

### Known limitations

- **The optional `SSO_RATE_LIMITER` binding was observed not enforcing** on at least one Cloudflare
  account — present, but returning success for every call with no `429` ever issued. The check fails
  open by design, so a non-enforcing binding is completely silent. Verify it works on your account
  before treating it as a control.
- **Repair runs after the response**, so there is a brief window in which a login has succeeded but the
  device does not yet exist. Measured at under five seconds and self-correcting; see `ARCHITECTURE.md`
  for why running it inline was rejected.
- `SSO_REQUIRE_EMAIL` and `SSO_SEND_ACTIVATION_EMAIL` are deployment-wide; they have no per-domain
  override.

[0.2.0]: https://github.com/dszp/ringotel-ns-sso/compare/v0.1.3...v0.2.0
[0.1.3]: https://github.com/dszp/ringotel-ns-sso/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/dszp/ringotel-ns-sso/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/dszp/ringotel-ns-sso/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/dszp/ringotel-ns-sso/releases/tag/v0.1.0

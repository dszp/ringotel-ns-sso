# Changelog

All notable changes to `ringotel-ns-sso` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

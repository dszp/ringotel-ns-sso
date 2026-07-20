import { parseConfig, type Env } from './config.js';
import { authorize } from './authorize.js';
import { buildDeps } from './clients.js';
import { runDeviceRepair } from './repair.js';

/** Constant-time-ish string compare (avoids trivial early-exit timing on the Basic secret). Intentionally
 *  leaks only credential LENGTH via the length-mismatch fast path below — acceptable for this threat
 *  model (a webhook shared secret compared server-side, not a public password-guessing surface). */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function checkBasic(request: Request, user: string, pass: string): boolean {
  const h = request.headers.get('authorization') ?? '';
  if (!h.startsWith('Basic ')) return false;
  let decoded = '';
  try { decoded = atob(h.slice(6)); } catch { return false; }
  const i = decoded.indexOf(':');
  if (i < 0) return false;
  return safeEqual(decoded.slice(0, i), user) && safeEqual(decoded.slice(i + 1), pass);
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/health') return new Response('ok', { status: 200 });

    // Config is parsed BEFORE routing because the accepted paths are themselves configurable
    // (SSO_PATHS) — we can't know whether this request is routable until it's parsed. A misconfig
    // still fails CLOSED (403), never 500; on a broken deploy that now covers unknown paths too,
    // which is the safe direction. `/health` stays above this so a liveness probe never depends on
    // configuration being valid.
    let config;
    try { config = parseConfig(env); } catch (e) {
      console.log(JSON.stringify({ outcome: 'deny', reason: 'misconfigured', error: String((e as Error).message) }));
      return new Response('forbidden', { status: 403 });
    }

    if (!config.paths.includes(url.pathname) || request.method !== 'POST') return new Response('not found', { status: 404 });

    if (!checkBasic(request, config.basicUser, config.basicPassword)) {
      // Logged: without this, someone grinding the webhook's shared secret is invisible in observability.
      console.log(JSON.stringify({ outcome: 'deny', reason: 'bad-basic-auth' }));
      return new Response('unauthorized', { status: 401, headers: { 'www-authenticate': 'Basic' } });
    }

    let input: { username?: unknown; password?: unknown; domain?: unknown };
    try { input = (await request.json()) as typeof input; } catch {
      console.log(JSON.stringify({ outcome: 'deny', reason: 'malformed-body' }));
      return new Response('forbidden', { status: 403 });
    }
    // (M7) Validate field TYPES explicitly rather than relying on a thrown exception downstream (e.g. a
    // numeric/object `domain` reaching `.toLowerCase()`/`.trim()` calls in authorize.ts/orgBranch.ts).
    // `domain` is OPTIONAL — Ringotel's real SSO webhook sends only `username`+`password` (confirmed
    // live: its SSO service definition's `$domain$` placeholder resolves to nothing). The NetSapiens
    // domain instead comes from the `<ext>@<short-domain>` shape of `username` and, authoritatively,
    // from the NS self-record inside `authorize()`. So: present-and-non-string → 403; absent/null/empty
    // → valid, and `undefined` is what's passed through to `authorize`.
    if (typeof input.username !== 'string' || typeof input.password !== 'string') {
      console.log(JSON.stringify({ outcome: 'deny', reason: 'bad-body-fields' }));
      return new Response('forbidden', { status: 403 });
    }
    if (input.domain != null && typeof input.domain !== 'string') {
      console.log(JSON.stringify({ outcome: 'deny', reason: 'bad-body-fields' }));
      return new Response('forbidden', { status: 403 });
    }
    if (!input.username || !input.password) {
      console.log(JSON.stringify({ outcome: 'deny', reason: 'empty-credentials' }));
      return new Response('forbidden', { status: 403 });
    }
    const domain = typeof input.domain === 'string' && input.domain ? input.domain : undefined;

    // Per-account rate limit (abuse control, not an auth control) — keyed on domain:username so it
    // stops a brute-forcer against one account without throttling all callers behind Ringotel's (or a proxy's)
    // proxy's shared source IPs. Fails OPEN if the binding is absent, and never turns a limiter error
    // into a 500 — a missing/broken binding must not block auth. `domain` may be absent (see above); the
    // key still stays per-account via the username half.
    if (env.SSO_RATE_LIMITER) {
      // Keyed on the USERNAME alone. It deliberately does NOT include the request body's `domain`: that
      // field is caller-controlled, so varying it per attempt would mint a fresh bucket for the same
      // account and defeat the entire point of a per-account limit. The username already carries the
      // tenant (`<ext>@<label>`), and it is the value the brute-forcer is actually iterating against.
      const rlKey = String(input.username).trim().toLowerCase();
      try {
        const { success } = await env.SSO_RATE_LIMITER.limit({ key: rlKey });
        if (!success) {
          console.log(JSON.stringify({ outcome: 'deny', reason: 'rate-limited', domain }));
          return new Response('too many requests', { status: 429 });
        }
      } catch (e) {
        // NOT outcome:'allow' — no decision has been made yet; that mislabels rate-limiter faults as
        // successful logins in any `outcome` query.
        console.log(JSON.stringify({ outcome: 'error', reason: 'rate-limiter-error', error: String((e as Error).message) }));
      }
    }

    try {
      const deps = buildDeps(config);
      const result = await authorize({ username: input.username, password: input.password, domain }, deps);
      console.log(JSON.stringify(result.log));
      if (result.status !== 200) return new Response('forbidden', { status: 403 });
      // Housekeeping AFTER the response: adds no latency to the login and cannot change its outcome.
      // `runDeviceRepair` never throws, but the waitUntil is still guarded — an unhandled rejection here
      // would be invisible, and this must never be able to disturb a login that already succeeded.
      if (result.repair) {
        const task = result.repair;
        ctx.waitUntil(
          runDeviceRepair(task, deps)
            .then((l) => console.log(JSON.stringify(l)))
            .catch((e) =>
              console.log(JSON.stringify({ housekeeping: 'device-check', result: 'error', error: String((e as Error).message) })),
            ),
        );
      }
      return json(200, result.body);
    } catch (e) {
      // Upstream error messages can embed a slice of a vendor response body. Nothing secret reaches
      // here today (credentials travel in requests, and success bodies are never stringified into
      // errors), but the content is vendor-controlled, so bound it and keep the error type.
      const err = e as Error;
      console.log(JSON.stringify({ outcome: 'error', name: err?.name, error: String(err?.message ?? '').slice(0, 200) }));
      return new Response('forbidden', { status: 403 }); // fail closed on any unexpected error
    }
  },
};

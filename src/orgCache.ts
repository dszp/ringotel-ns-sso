/**
 * A short-lived cache for the Ringotel ORGANIZATION LIST.
 *
 * Why this exists: resolving a bare extension needs the org list *before* the caller's NetSapiens
 * credentials have been checked, so a flood of failing logins would otherwise drive one full
 * `getOrganizations` each onto the Ringotel AdminAPI. If that key gets throttled, every login fails —
 * including the ones that would have succeeded — so the blast radius of the abuse is much wider than the
 * requests causing it.
 *
 * Only the org list is cached, and only briefly. It is the fleet-wide, slow-moving read (an org appears
 * when a customer is onboarded), it is the one an unauthenticated request can reach, and it is the
 * expensive one. Branch reads are left uncached: they are per-org, cost one call, and carry the `address`
 * that binds a tenant — the value least worth serving stale.
 *
 * The staleness window is real and bounded: for up to the TTL, an org created seconds ago is invisible,
 * so a login for a brand-new customer can fail and succeed a minute later. That is the trade being made
 * deliberately, and it is why the default is measured in seconds rather than minutes.
 */
import type { Rec } from '@dszp/ringotel-lib';

/** The subset of the Cache API this needs — so a test can pass a plain object. */
export interface CacheLike {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

/**
 * Namespace the key by a HASH of the API token, never the token itself.
 *
 * `caches.default` is shared per zone, so two Workers deployed on one zone with different Ringotel
 * accounts would otherwise read each other's org lists — a cross-account data leak caused purely by a
 * key collision. The hash makes the key account-specific while keeping the secret out of it (cache keys
 * are URLs; they surface in traces and tooling).
 */
async function keyFor(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `https://ringotel-ns-sso.invalid/orgs/${hex.slice(0, 16)}`;
}

/**
 * Wrap `getOrganizations` with a cache read/write. `ttl <= 0` disables it entirely and returns the
 * original function, so the feature can be turned off without a second code path to reason about.
 *
 * Every cache fault — a miss, a parse failure, a `put` that throws — falls through to the live call. A
 * cache is an optimization; it must never be able to fail a login.
 */
export function cachedOrganizations(
  live: () => Promise<Rec[]>,
  opts: { cache?: CacheLike; token: string; ttl: number; waitUntil?: (p: Promise<unknown>) => void },
): () => Promise<Rec[]> {
  const { cache, token, ttl, waitUntil } = opts;
  if (!cache || ttl <= 0) return live;

  return async () => {
    let key: Request | undefined;
    try {
      key = new Request(await keyFor(token));
      const hit = await cache.match(key);
      if (hit) {
        const body = await hit.json();
        // A cached non-array would mean something else answered this key; treat it as a miss rather
        // than handing a wrong shape to the resolver.
        if (Array.isArray(body)) return body as Rec[];
      }
    } catch {
      // fall through to the live read
    }

    const orgs = await live();

    if (key) {
      const write = cache
        .put(
          key,
          new Response(JSON.stringify(orgs), {
            headers: { 'content-type': 'application/json', 'cache-control': `max-age=${Math.floor(ttl)}` },
          }),
        )
        .catch(() => {});
      // Off the response path when the caller can defer it; awaited otherwise so a test still sees it.
      if (waitUntil) waitUntil(write);
      else await write;
    }
    return orgs;
  };
}

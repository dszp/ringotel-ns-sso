/**
 * The org-list cache exists to keep an UNAUTHENTICATED flood off the Ringotel AdminAPI: resolving a bare
 * extension reads the org list before any credential is checked, and a throttled API key fails every
 * login, not just the abusive ones. It is an optimization, so every fault has to fall through to the
 * live read rather than fail a login.
 */
import { describe, it, expect, vi } from 'vitest';
import { cachedOrganizations, type CacheLike } from './orgCache.js';
import { parseConfig, ConfigError, type Env } from './config.js';

/** Minimal in-memory stand-in for `caches.default`, keyed by URL. TTL is not simulated. */
function memCache(): CacheLike & { size(): number } {
  const store = new Map<string, string>();
  return {
    async match(req: Request) {
      const hit = store.get(req.url);
      return hit === undefined ? undefined : new Response(hit, { headers: { 'content-type': 'application/json' } });
    },
    async put(req: Request, res: Response) { store.set(req.url, await res.text()); },
    size: () => store.size,
  };
}

const ORGS = [{ id: 'O1', domain: 'acmevoice' }];

describe('cachedOrganizations', () => {
  it('reads live once, then serves the cached list', async () => {
    const live = vi.fn(async () => ORGS);
    const get = cachedOrganizations(live, { cache: memCache(), token: 'tok', ttl: 60 });
    expect(await get()).toEqual(ORGS);
    expect(await get()).toEqual(ORGS);
    expect(live).toHaveBeenCalledTimes(1);
  });

  it('is a straight pass-through when disabled, with no cache writes at all', async () => {
    const cache = memCache();
    const live = vi.fn(async () => ORGS);
    const get = cachedOrganizations(live, { cache, token: 'tok', ttl: 0 });
    await get(); await get();
    expect(live).toHaveBeenCalledTimes(2);
    expect(cache.size()).toBe(0);
  });

  it('is a pass-through when the runtime has no cache', async () => {
    const live = vi.fn(async () => ORGS);
    const get = cachedOrganizations(live, { token: 'tok', ttl: 60 });
    await get();
    expect(live).toHaveBeenCalledTimes(1);
  });

  it('SEPARATES accounts: caches.default is shared per zone, so the key is token-derived', async () => {
    const cache = memCache();
    const a = cachedOrganizations(async () => [{ id: 'A' }], { cache, token: 'token-a', ttl: 60 });
    const b = cachedOrganizations(async () => [{ id: 'B' }], { cache, token: 'token-b', ttl: 60 });
    expect(await a()).toEqual([{ id: 'A' }]);
    // Without the token in the key this would return account A's fleet to account B.
    expect(await b()).toEqual([{ id: 'B' }]);
    expect(cache.size()).toBe(2);
  });

  it('never puts the token itself in the cache key', async () => {
    const seen: string[] = [];
    const cache: CacheLike = {
      async match(req) { seen.push(req.url); return undefined; },
      async put(req) { seen.push(req.url); },
    };
    await cachedOrganizations(async () => ORGS, { cache, token: 'super-secret-token', ttl: 60 })();
    expect(seen.length).toBeGreaterThan(0);
    for (const url of seen) expect(url).not.toContain('super-secret-token');
  });

  it('falls through to the live read when the cache read throws', async () => {
    const cache: CacheLike = { async match() { throw new Error('cache down'); }, async put() {} };
    const live = vi.fn(async () => ORGS);
    expect(await cachedOrganizations(live, { cache, token: 't', ttl: 60 })()).toEqual(ORGS);
    expect(live).toHaveBeenCalledTimes(1);
  });

  it('still answers when the cache WRITE throws — a cache must not fail a login', async () => {
    const cache: CacheLike = { async match() { return undefined; }, async put() { throw new Error('quota'); } };
    expect(await cachedOrganizations(async () => ORGS, { cache, token: 't', ttl: 60 })()).toEqual(ORGS);
  });

  it('treats a cached non-array as a miss rather than handing on a wrong shape', async () => {
    const cache: CacheLike = {
      async match() { return new Response('{"not":"an array"}'); },
      async put() {},
    };
    const live = vi.fn(async () => ORGS);
    expect(await cachedOrganizations(live, { cache, token: 't', ttl: 60 })()).toEqual(ORGS);
    expect(live).toHaveBeenCalledTimes(1);
  });

  it('defers the write when a waitUntil is supplied, keeping it off the response path', async () => {
    const pending: Promise<unknown>[] = [];
    const cache = memCache();
    const get = cachedOrganizations(async () => ORGS, {
      cache, token: 't', ttl: 60, waitUntil: (p) => { pending.push(p); },
    });
    await get();
    expect(pending).toHaveLength(1);
    await Promise.all(pending);
    expect(cache.size()).toBe(1);
  });
});

describe('SSO_ORG_CACHE_TTL', () => {
  const env = (over: Partial<Env> = {}): Env => ({
    SSO_BASIC_USER: 'r', SSO_BASIC_PASSWORD: 'p',
    NS_SERVER: 'api.example.com', NS_OAUTH_CLIENT_ID: 'c', NS_OAUTH_CLIENT_SECRET: 's',
    RINGOTEL_API_KEY: 'rt', NS_API_KEY: 'nst', ...over,
  });
  it('defaults to 60 seconds', () => expect(parseConfig(env()).orgCacheTtl).toBe(60));
  it('accepts 0 as "off"', () => expect(parseConfig(env({ SSO_ORG_CACHE_TTL: '0' })).orgCacheTtl).toBe(0));
  it('rejects a typo instead of silently disabling an abuse control', () => {
    expect(() => parseConfig(env({ SSO_ORG_CACHE_TTL: 'sixty' }))).toThrow(ConfigError);
    expect(() => parseConfig(env({ SSO_ORG_CACHE_TTL: '-1' }))).toThrow(ConfigError);
  });
});

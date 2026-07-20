import { describe, it, expect, vi } from 'vitest';
import worker from './worker.js';
import type { Env } from './config.js';

const ENV: Env = {
  SSO_BASIC_USER: 'ringotel', SSO_BASIC_PASSWORD: 'pw',
  NS_SERVER: 'api.example.com', NS_OAUTH_CLIENT_ID: 'c', NS_OAUTH_CLIENT_SECRET: 's',
  RINGOTEL_API_KEY: 'rt', NS_API_KEY: 'nst',
};
const basic = 'Basic ' + btoa('ringotel:pw');
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
const authorizeReq = (auth?: string) =>
  new Request('https://w/authorize', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(auth ? { authorization: auth } : {}) },
    body: JSON.stringify({ username: '100@demo', password: 'x', domain: 'demo.12345.service' }),
  });

const reqAt = (path: string, auth = basic) =>
  new Request(`https://w${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: auth },
    body: JSON.stringify({ username: '100@demo', password: 'x', domain: 'demo.12345.service' }),
  });

describe('configurable request paths (SSO_PATHS)', () => {
  // A 401 here means the request WAS routed and reached the Basic-auth gate; 404 means it was not.
  // Using a deliberately wrong credential keeps these tests about ROUTING only.
  const wrong = 'Basic ' + btoa('x:y');

  it('defaults to /authorize when SSO_PATHS is unset', async () => {
    expect((await worker.fetch(reqAt('/authorize', wrong), ENV, ctx)).status).toBe(401);
    expect((await worker.fetch(reqAt('/webhook/abc', wrong), ENV, ctx)).status).toBe(404);
  });

  it('routes a configured custom path, and still 404s an unconfigured one', async () => {
    const env = { ...ENV, SSO_PATHS: '/webhook/abc' };
    expect((await worker.fetch(reqAt('/webhook/abc', wrong), env, ctx)).status).toBe(401);
    expect((await worker.fetch(reqAt('/nope', wrong), env, ctx)).status).toBe(404);
  });

  it('accepts MULTIPLE paths at once (the point: cutover without a flag day)', async () => {
    const env = { ...ENV, SSO_PATHS: '/authorize,/webhook/abc' };
    expect((await worker.fetch(reqAt('/authorize', wrong), env, ctx)).status).toBe(401);
    expect((await worker.fetch(reqAt('/webhook/abc', wrong), env, ctx)).status).toBe(401);
  });

  it('tolerates missing leading slashes and whitespace', async () => {
    const env = { ...ENV, SSO_PATHS: ' webhook/abc , /authorize ' };
    expect((await worker.fetch(reqAt('/webhook/abc', wrong), env, ctx)).status).toBe(401);
    expect((await worker.fetch(reqAt('/authorize', wrong), env, ctx)).status).toBe(401);
  });

  it('a blank SSO_PATHS falls back to /authorize rather than answering on nothing', async () => {
    const env = { ...ENV, SSO_PATHS: '   ' };
    expect((await worker.fetch(reqAt('/authorize', wrong), env, ctx)).status).toBe(401);
  });

  it('GET on a configured path is still 404 (POST only)', async () => {
    const env = { ...ENV, SSO_PATHS: '/webhook/abc' };
    const res = await worker.fetch(new Request('https://w/webhook/abc'), env, ctx);
    expect(res.status).toBe(404);
  });

  it('/health is served regardless of SSO_PATHS', async () => {
    const env = { ...ENV, SSO_PATHS: '/webhook/abc' };
    expect((await worker.fetch(new Request('https://w/health'), env, ctx)).status).toBe(200);
  });
});

describe('worker', () => {
  it('GET /health → 200', async () => {
    const res = await worker.fetch(new Request('https://w/health'), ENV, ctx);
    expect(res.status).toBe(200);
  });

  it('POST /authorize without Basic auth → 401', async () => {
    const res = await worker.fetch(authorizeReq(), ENV, ctx);
    expect(res.status).toBe(401);
  });

  it('POST /authorize with wrong Basic auth → 401', async () => {
    const res = await worker.fetch(authorizeReq('Basic ' + btoa('x:y')), ENV, ctx);
    expect(res.status).toBe(401);
  });

  it('misconfigured env (missing master key) → 403 (fail closed), never 5xx', async () => {
    const res = await worker.fetch(authorizeReq(basic), { ...ENV, NS_OAUTH_CLIENT_ID: undefined }, ctx);
    expect(res.status).toBe(403);
  });

  it('a body with only username+password (no `domain`, the real Ringotel shape) is NOT rejected by body validation', async () => {
    const noDomainReq = new Request('https://w/authorize', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: basic },
      body: JSON.stringify({ username: '100@demo', password: 'x' }),
    });
    const limit = vi.fn(async (_o: { key: string }) => ({ success: true }));
    const res = await worker.fetch(noDomainReq, { ...ENV, SSO_RATE_LIMITER: { limit } }, ctx);
    // It must get PAST body validation — the rate limiter (which only runs after validation) is reached,
    // and the eventual 403 comes from authorize()'s real (network-backed, failing-in-this-sandbox) path,
    // never from the earlier "missing domain" validation check this fix removes.
    expect(limit).toHaveBeenCalledOnce();
    expect(limit).toHaveBeenCalledWith({ key: '100@demo' });
    expect(res.status).toBe(403);
  });

  describe('per-account rate limit', () => {
    it('limiter denies → 429, never reaches authorize (no NS call attempted)', async () => {
      const limit = vi.fn(async (_o: { key: string }) => ({ success: false }));
      const res = await worker.fetch(authorizeReq(basic), { ...ENV, SSO_RATE_LIMITER: { limit } }, ctx);
      expect(res.status).toBe(429);
      expect(limit).toHaveBeenCalledOnce();
      // Keyed on lowercased domain:username, never the raw case, and never logged/leaked beyond the key itself.
      expect(limit).toHaveBeenCalledWith({ key: '100@demo' });
    });

    it('limiter allows → proceeds past the rate check to the normal (network-backed) fail-closed path', async () => {
      const limit = vi.fn(async (_o: { key: string }) => ({ success: true }));
      const res = await worker.fetch(authorizeReq(basic), { ...ENV, SSO_RATE_LIMITER: { limit } }, ctx);
      expect(limit).toHaveBeenCalledOnce();
      // No network/deps stubbed here (this is the black-box HTTP-boundary test, mirrors the
      // "misconfigured env" case above) — authorize() runs for real and its outbound NS call fails in
      // this sandbox, which the worker's outer try/catch turns into a 403, never a 429 and never a 5xx.
      expect(res.status).toBe(403);
    });

    it('no SSO_RATE_LIMITER on env → unchanged, fail-open (same outcome as without the feature)', async () => {
      const res = await worker.fetch(authorizeReq(basic), ENV, ctx);
      expect(res.status).toBe(403);
    });

    it('a limiter that throws is treated as allow, never a 500', async () => {
      const limit = vi.fn(async (_o: { key: string }) => { throw new Error('binding unavailable'); });
      const res = await worker.fetch(authorizeReq(basic), { ...ENV, SSO_RATE_LIMITER: { limit } }, ctx);
      expect(limit).toHaveBeenCalledOnce();
      expect(res.status).toBe(403); // same fail-closed-via-authorize path as the other allow cases, not 5xx
    });
  });

  it('accepts an ExecutionContext and schedules nothing on a denial', async () => {
    const scheduled: Promise<unknown>[] = [];
    const denyCtx = { waitUntil: (p: Promise<unknown>) => scheduled.push(p), passThroughOnException: () => {} };
    const res = await worker.fetch(authorizeReq(basic), { ...ENV, SSO_REPAIR_DOMAINS: '*' }, denyCtx as never);
    expect(res.status).toBe(403);
    expect(scheduled).toHaveLength(0);
  });

  describe('ctx.waitUntil wiring (full network stack stubbed)', () => {
    // Everything below composes the REAL `buildDeps` (worker.ts's actual production path, not a fake
    // AuthorizeDeps) with `globalThis.fetch` stubbed to answer each real outbound call this Worker
    // makes for a successful, repair-eligible `allow`: the NS OAuth password grant, the NS self-record
    // read, the three Ringotel JSON-RPC reads (getOrganizations/getBranches/getUsers), and — because
    // SSO_REPAIR_DOMAINS is set below, so `runDeviceRepair` actually runs inside the scheduled promise
    // — the NS device list read. This is the only test in the suite that proves `ctx.waitUntil(...)` is
    // actually wired to something real end-to-end; everything else either stubs `AuthorizeDeps`
    // directly (authorize.test.ts) or never reaches a successful `allow` (the black-box tests above).
    const rtOrgResult = [{ id: 'O1', domain: 'demo' }];
    const rtBranchResult = [{ id: 'B1', address: 'demo.12345.service' }];
    const rtUsersResult = [{ id: 'A', branchid: 'B1', extension: '100', status: 1, username: '100r', authname: '100r' }];
    const selfRecord = { user: '100', domain: 'demo.12345.service', email: 'al@example.com' };

    function stubFetch(): ReturnType<typeof vi.fn> {
      return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input instanceof Request ? input.url : input);
        const method = init?.method ?? (input instanceof Request ? input.method : 'GET');

        if (url.includes('/ns-api/oauth2/token/') && method === 'POST') {
          return new Response(JSON.stringify({ access_token: 'TOK' }), { status: 200 });
        }
        if (url.includes('/ns-api/v2/domains/~/users/~')) {
          return new Response(JSON.stringify(selfRecord), { status: 200 });
        }
        if (url === 'https://shell.ringotel.co/api' && method === 'POST') {
          const body = JSON.parse(String(init?.body ?? '{}')) as { method: string };
          const result =
            body.method === 'getOrganizations' ? rtOrgResult :
            body.method === 'getBranches' ? rtBranchResult :
            body.method === 'getUsers' ? rtUsersResult : [];
          return new Response(JSON.stringify({ result }), { status: 200 });
        }
        // NsWriteClient.getDevices, reached only from inside the scheduled repair promise — device
        // already present, so runDeviceRepair resolves 'ok' with no further (create/update) calls.
        if (url.includes('/ns-api/v2/domains/') && url.includes('/devices') && method === 'GET') {
          return new Response(JSON.stringify([{ device: '100r' }]), { status: 200 });
        }
        throw new Error(`unstubbed fetch: ${method} ${url}`);
      });
    }

    it('a successful allow returns 200 and schedules exactly one waitUntil promise', async () => {
      const fetchStub = stubFetch();
      const originalFetch = globalThis.fetch;
      globalThis.fetch = fetchStub as unknown as typeof fetch;
      try {
        const scheduled: Promise<unknown>[] = [];
        const spyCtx = { waitUntil: (p: Promise<unknown>) => scheduled.push(p), passThroughOnException: () => {} };
        const res = await worker.fetch(authorizeReq(basic), { ...ENV, SSO_REPAIR_DOMAINS: 'demo.12345.service' }, spyCtx as never);
        expect(res.status).toBe(200);
        expect(scheduled).toHaveLength(1);
        // Drain it so the test doesn't leave a dangling unhandled promise behind.
        await scheduled[0];
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});

describe('rate-limit key is not caller-steerable', () => {
  // Regression: the key used to include the request body's `domain` — the one field the design refuses
  // to trust. A caller holding the Basic secret could vary it per attempt ('a', 'b', 'c'…) to mint a
  // fresh bucket for the SAME account, defeating the per-account limit entirely.
  const keyFor = async (body: Record<string, unknown>) => {
    const keys: string[] = [];
    const limit = vi.fn(async (o: { key: string }) => { keys.push(o.key); return { success: true }; });
    await worker.fetch(new Request('https://w/authorize', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: basic },
      body: JSON.stringify(body),
    }), { ...ENV, SSO_RATE_LIMITER: { limit } } as Env, ctx);
    return keys[0];
  };

  it('varying the body domain does NOT change the bucket', async () => {
    const a = await keyFor({ username: '100@demo', password: 'x', domain: 'a.12345.service' });
    const b = await keyFor({ username: '100@demo', password: 'x', domain: 'b.12345.service' });
    const none = await keyFor({ username: '100@demo', password: 'x' });
    expect(a).toBe(b);
    expect(a).toBe(none);
  });

  it('the key is the normalised username, so casing and padding cannot split buckets', async () => {
    expect(await keyFor({ username: '  100@DEMO  ', password: 'x' })).toBe('100@demo');
  });

  it('different accounts still get different buckets', async () => {
    expect(await keyFor({ username: '101@demo', password: 'x' })).not
      .toBe(await keyFor({ username: '100@demo', password: 'x' }));
  });
});

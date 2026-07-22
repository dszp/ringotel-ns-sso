/**
 * The Ringotel sign-in screen asks for an ORG DOMAIN plus a username. Ringotel does not know the
 * NetSapiens domain and can never send it, so a bare extension has to be resolved through that org
 * domain before there is anything to authenticate. These tests cover the pure helpers; authorize.test.ts
 * covers the pipeline they feed.
 */
import { describe, it, expect, vi } from 'vitest';
import { parseLogin, loginCandidates, domainClaimMatches, firstLabel } from './login.js';
import { resolveNsDomainByRtDomain } from './orgBranch.js';
import { authorize, type AuthorizeDeps } from './authorize.js';
import { parseConfig, ConfigError, type Env } from './config.js';

describe('parseLogin', () => {
  it('splits a username that carries a domain', () => {
    expect(parseLogin('1045@acme')).toEqual({ ext: '1045', label: 'acme' });
  });
  it('reports a bare extension as having no domain', () => {
    expect(parseLogin('1045')).toEqual({ ext: '1045' });
  });
  it('splits on the LAST @, so an email-shaped login still yields its tenant', () => {
    expect(parseLogin('a@b@acme')).toEqual({ ext: 'a@b', label: 'acme' });
  });
  it('treats a dangling or leading @ as no domain rather than an empty one', () => {
    expect(parseLogin('1045@')).toEqual({ ext: '1045@' });
    expect(parseLogin('@acme')).toEqual({ ext: '@acme' });
  });
});

describe('loginCandidates', () => {
  it('tries the short form first, then the full domain', () => {
    expect(loginCandidates('1045', 'acme.12345.service')).toEqual(['1045@acme', '1045@acme.12345.service']);
  });
  it('pins a single spelling when configured, so no failed grant is spent discovering it', () => {
    expect(loginCandidates('1045', 'acme.12345.service', 'short')).toEqual(['1045@acme']);
    expect(loginCandidates('1045', 'acme.12345.service', 'full')).toEqual(['1045@acme.12345.service']);
  });
  it('never offers the same spelling twice for a single-label domain', () => {
    expect(loginCandidates('1045', 'acme')).toEqual(['1045@acme']);
  });
  it('is capped at two attempts — failed grants count against lockout policy', () => {
    expect(loginCandidates('1045', 'a.b.c.d').length).toBeLessThanOrEqual(2);
  });
  it('firstLabel takes the leading label', () => {
    expect(firstLabel('acme.12345.service')).toBe('acme');
  });
});

describe('domainClaimMatches', () => {
  const tenant = { nsDomain: 'acme.12345.service', rtDomain: 'acmevoice' };
  it('accepts the Ringotel org domain — the only shape Ringotel can send', () => {
    expect(domainClaimMatches('acmevoice', tenant)).toBe(true);
  });
  it('accepts the NetSapiens domain and its first label, for a proxy or a manual test', () => {
    expect(domainClaimMatches('acme.12345.service', tenant)).toBe(true);
    expect(domainClaimMatches('acme', tenant)).toBe(true);
  });
  it('is case-insensitive', () => {
    expect(domainClaimMatches('ACMEVoice', tenant)).toBe(true);
  });
  it('refuses another tenant, which is the whole point of the guard', () => {
    expect(domainClaimMatches('other', tenant)).toBe(false);
    expect(domainClaimMatches('other.12345.service', tenant)).toBe(false);
  });
  it('an empty claim contradicts nothing', () => {
    expect(domainClaimMatches('', tenant)).toBe(true);
  });
  it('without a resolved Ringotel domain, only the NetSapiens spellings can match', () => {
    expect(domainClaimMatches('acmevoice', { nsDomain: 'acme.12345.service' })).toBe(false);
    expect(domainClaimMatches('acme', { nsDomain: 'acme.12345.service' })).toBe(true);
  });
});

describe('resolveNsDomainByRtDomain', () => {
  const read = (orgs: any[], branches: Record<string, any[]>) => ({
    getOrganizations: async () => orgs,
    getBranches: async (id: string) => branches[id] ?? [],
  });

  it('resolves an org domain to the branch address, which is the NetSapiens domain', async () => {
    const r = await resolveNsDomainByRtDomain(
      read([{ id: 'O1', domain: 'acmevoice' }], { O1: [{ id: 'B1', address: 'acme.12345.service' }] }),
      'acmevoice',
    );
    expect(r).toEqual({ ok: true, nsDomain: 'acme.12345.service' });
  });

  it('matches case-insensitively', async () => {
    const r = await resolveNsDomainByRtDomain(
      read([{ id: 'O1', domain: 'AcmeVoice' }], { O1: [{ id: 'B1', address: 'Acme.12345.Service' }] }),
      'acmevoice',
    );
    expect(r.ok && r.nsDomain).toBe('acme.12345.service');
  });

  it('ignores a branch whose own domain answers for something else', async () => {
    const r = await resolveNsDomainByRtDomain(
      read([{ id: 'O1', domain: 'acmevoice' }], {
        O1: [
          { id: 'B1', address: 'acme.12345.service' },
          { id: 'B2', domain: 'otherbrand', address: 'other.12345.service' },
        ],
      }),
      'acmevoice',
    );
    // Without that rule a multi-branch org would look ambiguous and refuse every login.
    expect(r).toEqual({ ok: true, nsDomain: 'acme.12345.service' });
  });

  it('FAILS CLOSED when one org domain answers for two branch addresses', async () => {
    const r = await resolveNsDomainByRtDomain(
      read([{ id: 'O1', domain: 'acmevoice' }], {
        O1: [{ id: 'B1', address: 'acme.12345.service' }, { id: 'B2', address: 'acme2.12345.service' }],
      }),
      'acmevoice',
    );
    // Picking one would route a login into a domain the user never named.
    expect(r).toEqual({ ok: false, reason: 'ambiguous' });
  });

  it('reports not-found distinctly — the operator fix is a different one', async () => {
    const r = await resolveNsDomainByRtDomain(read([{ id: 'O1', domain: 'other' }], {}), 'acmevoice');
    expect(r).toEqual({ ok: false, reason: 'not-found' });
  });

  it('an org with no addressed branch is not-found, not a false positive', async () => {
    const r = await resolveNsDomainByRtDomain(
      read([{ id: 'O1', domain: 'acmevoice' }], { O1: [{ id: 'B1' }] }),
      'acmevoice',
    );
    expect(r).toEqual({ ok: false, reason: 'not-found' });
  });

  it('does not read branches when no org carries the domain', async () => {
    const getBranches = vi.fn(async () => []);
    const r = await resolveNsDomainByRtDomain(
      { getOrganizations: async () => [{ id: 'O1', domain: 'other' }], getBranches },
      'acmevoice',
    );
    expect(r.ok).toBe(false);
    expect(getBranches).not.toHaveBeenCalled();
  });
});

// ── The pipeline: a bare extension plus a Ringotel org domain ────────────────────────────────────
const env = (over: Partial<Env> = {}): Env => ({
  SSO_BASIC_USER: 'r', SSO_BASIC_PASSWORD: 'p',
  NS_SERVER: 'api.example.com', NS_OAUTH_CLIENT_ID: 'c', NS_OAUTH_CLIENT_SECRET: 's',
  RINGOTEL_API_KEY: 'rt', NS_API_KEY: 'nst', ...over,
});

const baseSelf = {
  user: '100', domain: 'demo.12345.service',
  email: 'al@example.com', 'name-first-name': 'Al', 'name-last-name': 'Ice',
};

/** Accepts exactly one spelling of the username; records every spelling it was offered. */
const authAccepting = (accepted: string) => {
  const tried: string[] = [];
  return {
    tried,
    auth: {
      authenticate: async (u: string) => {
        tried.push(u);
        return u === accepted ? { ok: true, self: baseSelf } : { ok: false };
      },
    },
  };
};

// The org is named after the NetSapiens label but carries a DIFFERENT Ringotel domain — the shape that
// makes this whole feature necessary, and the one the forward resolver already handles.
const reader = {
  getOrganizations: async () => [{ id: 'O1', name: 'demo', domain: 'demovoice' }],
  getBranches: async () => [{ id: 'B1', address: 'demo.12345.service' }],
  getUsers: async () => [{ id: 'A', branchid: 'B1', extension: '100', status: 1, username: '100r', authname: '100r' }],
};

function deps(over: Partial<AuthorizeDeps> = {}, cfgEnv: Env = env()): AuthorizeDeps {
  return {
    config: parseConfig(cfgEnv),
    auth: { authenticate: async () => ({ ok: true, self: baseSelf }) },
    read: reader,
    getWrite: async () => { throw new Error('no write in this test'); },
    ...over,
  } as AuthorizeDeps;
}

describe('authorize: bare extension + Ringotel org domain', () => {
  it('backfills the NetSapiens login from the org domain and signs in', async () => {
    const { auth, tried } = authAccepting('100@demo');
    const r = await authorize({ username: '100', password: 'pw', domain: 'demovoice' }, deps({ auth } as any));
    expect(r.status).toBe(200);
    expect(tried).toEqual(['100@demo']);
    expect(r.log.resolvedNsDomain).toBe('demo.12345.service');
    // Strongest form of the guard: the tenant they named is the tenant they authenticated into.
    expect(r.log.domainCheck).toBe('ok-resolved');
    // The response still binds the session by the RINGOTEL domain, unchanged.
    expect(r.body).toEqual({ extension: '100', authname: '100r', domain: 'demovoice' });
  });

  it('falls back to the full-domain spelling when the short one is not the stored login', async () => {
    const { auth, tried } = authAccepting('100@demo.12345.service');
    const r = await authorize({ username: '100', password: 'pw', domain: 'demovoice' }, deps({ auth } as any));
    expect(r.status).toBe(200);
    expect(tried).toEqual(['100@demo', '100@demo.12345.service']);
  });

  it('spends only ONE grant when the spelling is pinned', async () => {
    const { auth, tried } = authAccepting('100@demo.12345.service');
    const r = await authorize(
      { username: '100', password: 'pw', domain: 'demovoice' },
      deps({ auth } as any, env({ SSO_LOGIN_FORM: 'short' })),
    );
    expect(r.status).toBe(403);
    expect(tried).toEqual(['100@demo']);
  });

  it('REFUSES a bare extension with no domain, before any NetSapiens call', async () => {
    const authenticate = vi.fn(async () => ({ ok: true, self: baseSelf }));
    const r = await authorize({ username: '100', password: 'pw' }, deps({ auth: { authenticate } } as any));
    expect(r.status).toBe(403);
    expect(r.log.reason).toBe('no-domain-hint');
    expect(authenticate).not.toHaveBeenCalled();
  });

  it('refuses an unknown org domain without checking credentials', async () => {
    const authenticate = vi.fn(async () => ({ ok: true, self: baseSelf }));
    const r = await authorize(
      { username: '100', password: 'pw', domain: 'nosuchorg' },
      deps({ auth: { authenticate } } as any),
    );
    expect(r.status).toBe(403);
    expect(r.log.reason).toBe('unknown-org-domain');
    expect(authenticate).not.toHaveBeenCalled();
  });

  it('refuses an ambiguous org domain rather than guessing a tenant', async () => {
    const read = {
      ...reader,
      getBranches: async () => [{ id: 'B1', address: 'demo.12345.service' }, { id: 'B2', address: 'other.12345.service' }],
    };
    const r = await authorize({ username: '100', password: 'pw', domain: 'demovoice' }, deps({ read } as any));
    expect(r.status).toBe(403);
    expect(r.log.reason).toBe('ambiguous-org-domain');
  });

  it('SSO_RT_DOMAIN_MAP wins over the live lookup and skips it entirely', async () => {
    const { auth, tried } = authAccepting('100@demo');
    const getOrganizations = vi.fn(async () => [{ id: 'O1', name: 'demo', domain: 'demovoice' }]);
    const r = await authorize(
      { username: '100', password: 'pw', domain: 'weird-brand' },
      deps(
        { auth, read: { ...reader, getOrganizations } } as any,
        env({ SSO_RT_DOMAIN_MAP: '{"weird-brand":"demo.12345.service"}' }),
      ),
    );
    expect(r.log.rtDomainSource).toBe('map');
    expect(r.log.domainCheck).toBe('ok-resolved');
    expect(tried).toEqual(['100@demo']);
    // The org list is still read once — by resolveOrgBranch, on the authenticated path — never twice.
    expect(getOrganizations).toHaveBeenCalledTimes(1);
    expect(r.status).toBe(200);
  });

  it('reads the org list ONCE across the reverse lookup and the forward resolve', async () => {
    const { auth } = authAccepting('100@demo');
    const getOrganizations = vi.fn(async () => [{ id: 'O1', name: 'demo', domain: 'demovoice' }]);
    const getBranches = vi.fn(async () => [{ id: 'B1', address: 'demo.12345.service' }]);
    await authorize(
      { username: '100', password: 'pw', domain: 'demovoice' },
      deps({ auth, read: { ...reader, getOrganizations, getBranches } } as any),
    );
    expect(getOrganizations).toHaveBeenCalledTimes(1);
    expect(getBranches).toHaveBeenCalledTimes(1);
  });
});

describe('authorize: the domain claim is still a cross-tenant guard', () => {
  it('accepts the Ringotel org domain for a username that already carries its tenant', async () => {
    const r = await authorize({ username: '100@demo', password: 'pw', domain: 'demovoice' }, deps());
    expect(r.status).toBe(200);
    expect(r.log.domainCheck).toBe('ok-rt');
    expect(r.log.loginForm).toBe('verbatim');
  });

  it('still accepts a NetSapiens-shaped claim, as before', async () => {
    const r = await authorize({ username: '100@demo', password: 'pw', domain: 'demo.12345.service' }, deps());
    expect(r.status).toBe(200);
    expect(r.log.domainCheck).toBe('ok');
  });

  it('REFUSES a claim naming another tenant, before any Ringotel user is read', async () => {
    const getUsers = vi.fn(async () => []);
    const r = await authorize(
      { username: '100@demo', password: 'pw', domain: 'someone-else' },
      deps({ read: { ...reader, getUsers } } as any),
    );
    expect(r.status).toBe(403);
    expect(r.log.reason).toBe('domain-mismatch');
    expect(getUsers).not.toHaveBeenCalled();
  });

  it('no claim ⇒ nothing to check, unchanged', async () => {
    const r = await authorize({ username: '100@demo', password: 'pw' }, deps());
    expect(r.status).toBe(200);
    expect(r.log.domainCheck).toBe('skipped-not-supplied');
  });
});

describe('config: the new knobs fail closed', () => {
  it('SSO_LOGIN_FORM rejects a typo rather than silently defaulting', () => {
    expect(() => parseConfig(env({ SSO_LOGIN_FORM: 'shrot' }))).toThrow(ConfigError);
    expect(parseConfig(env()).loginForm).toBe('auto');
  });
  it('SSO_RT_DOMAIN_MAP rejects malformed JSON and non-string values', () => {
    expect(() => parseConfig(env({ SSO_RT_DOMAIN_MAP: 'nope' }))).toThrow(ConfigError);
    expect(() => parseConfig(env({ SSO_RT_DOMAIN_MAP: '{"a":1}' }))).toThrow(ConfigError);
  });
  it('SSO_RT_DOMAIN_MAP keys are lowercased so a caller casing cannot miss a rule', () => {
    expect(parseConfig(env({ SSO_RT_DOMAIN_MAP: '{"AcmeVoice":"acme.12345.service"}' })).rtDomainMap)
      .toEqual({ acmevoice: 'acme.12345.service' });
  });
});

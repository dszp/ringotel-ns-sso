import { describe, it, expect } from 'vitest';
import { domainAllowed, parseConfig, domainInList, ConfigError, type Env } from './config.js';

const base: Env = {
  SSO_BASIC_USER: 'ringotel', SSO_BASIC_PASSWORD: 'pw',
  NS_SERVER: 'api.example.com',
  NS_OAUTH_CLIENT_ID: 'cid', NS_OAUTH_CLIENT_SECRET: 'csec',
  RINGOTEL_API_KEY: 'rt',
  NS_API_KEY: 'nstoken',
};

describe('parseConfig', () => {
  it('parses a minimal valid env (validate-only, api write identity)', () => {
    const c = parseConfig(base);
    expect(c.suffix).toBe('r');
    expect(c.healDomains).toEqual([]);
    expect(c.provisionDomains).toEqual([]);
    expect(c.writeIdentity).toEqual({ kind: 'api', token: 'nstoken' });
    expect(c.nsOauthServer).toBe('api.example.com'); // defaults to NS_SERVER
    expect(c.eligibility.excludeNames).toEqual(['shared', 'shared voicemail', 'fax']);
  });

  it('prefers admin OAuth identity when NS_ADMIN_USER/PASS set', () => {
    const c = parseConfig({ ...base, NS_API_KEY: undefined, NS_ADMIN_USER: 'reseller', NS_ADMIN_PASS: 'x' });
    expect(c.writeIdentity).toEqual({ kind: 'admin', user: 'reseller', pass: 'x' });
  });

  it('throws when neither write identity is provided', () => {
    expect(() => parseConfig({ ...base, NS_API_KEY: undefined })).toThrow(ConfigError);
  });

  it('throws when the master key is missing', () => {
    expect(() => parseConfig({ ...base, NS_OAUTH_CLIENT_ID: undefined })).toThrow(ConfigError);
  });

  it('throws when the Basic credential is missing', () => {
    expect(() => parseConfig({ ...base, SSO_BASIC_PASSWORD: undefined })).toThrow(ConfigError);
  });

  it('parses allowlists: "*" and CSV (lowercased)', () => {
    const c = parseConfig({ ...base, SSO_PROVISION_DOMAINS: '*', SSO_HEAL_DOMAINS: 'A.12345.service, B.6.service' });
    expect(c.provisionDomains).toBe('*');
    expect(c.healDomains).toEqual(['a.12345.service', 'b.6.service']);
  });

  it('throws when NS_SERVER is missing', () => {
    expect(() => parseConfig({ ...base, NS_SERVER: undefined })).toThrow(ConfigError);
  });

  it('throws when NS_OAUTH_CLIENT_SECRET is missing', () => {
    expect(() => parseConfig({ ...base, NS_OAUTH_CLIENT_SECRET: undefined })).toThrow(ConfigError);
  });

  it('throws when RINGOTEL_API_KEY is missing', () => {
    expect(() => parseConfig({ ...base, RINGOTEL_API_KEY: undefined })).toThrow(ConfigError);
  });

  it('throws when SSO_BASIC_USER is missing', () => {
    expect(() => parseConfig({ ...base, SSO_BASIC_USER: undefined })).toThrow(ConfigError);
  });

  it('prefers admin identity over api key when both are set', () => {
    const c = parseConfig({ ...base, NS_API_KEY: 'nstoken', NS_ADMIN_USER: 'reseller', NS_ADMIN_PASS: 'x' });
    expect(c.writeIdentity).toEqual({ kind: 'admin', user: 'reseller', pass: 'x' });
  });

  describe('RINGOTEL_EXCLUDE_EXTS_BY_DOMAIN', () => {
    it('throws on invalid JSON', () => {
      expect(() => parseConfig({ ...base, RINGOTEL_EXCLUDE_EXTS_BY_DOMAIN: '{not json' })).toThrow(ConfigError);
    });

    it('throws on a JSON array (non-object)', () => {
      expect(() => parseConfig({ ...base, RINGOTEL_EXCLUDE_EXTS_BY_DOMAIN: '["demo.12345.service"]' })).toThrow(ConfigError);
    });

    it('throws on a bad entry value', () => {
      expect(() =>
        parseConfig({ ...base, RINGOTEL_EXCLUDE_EXTS_BY_DOMAIN: '{"demo.12345.service": 123}' }),
      ).toThrow(ConfigError);
    });

    it('accepts a valid add/remove entry', () => {
      const c = parseConfig({
        ...base,
        RINGOTEL_EXCLUDE_EXTS_BY_DOMAIN: '{"demo.12345.service": {"add": ["100"], "remove": ["200"]}}',
      });
      expect(c.eligibility.excludeExtsByDomain).toEqual({ 'demo.12345.service': { add: ['100'], remove: ['200'] } });
    });
  });

  describe('SSO_DOMAIN_MAP', () => {
    it('throws on invalid JSON', () => {
      expect(() => parseConfig({ ...base, SSO_DOMAIN_MAP: '{not json' })).toThrow(ConfigError);
    });

    it('throws on a bad value', () => {
      expect(() => parseConfig({ ...base, SSO_DOMAIN_MAP: '{"acme": 123}' })).toThrow(ConfigError);
    });

    it('produces mapping.rules for a valid map', () => {
      const c = parseConfig({ ...base, SSO_DOMAIN_MAP: '{"legacy":"acme"}' });
      expect(c.mapping.rules).toEqual([{ match: 'legacy', to: 'acme' }]);
    });
  });

  it('resellerOverride is always empty — an SSO login has no reseller to be', () => {
    const c = parseConfig({ ...base });
    expect(c.eligibility.resellerOverride.size).toBe(0);
  });

  it("requireEmail defaults to 'auto'", () => {
    expect(parseConfig({ ...base }).requireEmail).toBe('auto');
  });

  it('requireEmail accepts auto|always|never, case-insensitively', () => {
    for (const v of ['auto', 'ALWAYS', 'Never']) {
      expect(parseConfig({ ...base, SSO_REQUIRE_EMAIL: v }).requireEmail).toBe(v.toLowerCase());
    }
  });

  it('requireEmail REJECTS an unknown value rather than guessing', () => {
    // A typo here would silently change who gets auto-provisioned, so it must fail closed.
    expect(() => parseConfig({ ...base, SSO_REQUIRE_EMAIL: 'yes' })).toThrow(/auto\|always\|never/);
  });

  it('block lists default to empty (nothing blocked)', () => {
    const c = parseConfig({ ...base });
    expect(c.blockDomains).toEqual([]);
    expect(c.healBlockDomains).toEqual([]);
    expect(c.provisionBlockDomains).toEqual([]);
    expect(c.repairBlockDomains).toEqual([]);
  });

  it('block lists parse CSV lowercased and honour the wildcard', () => {
    const c = parseConfig({ ...base, SSO_BLOCK_DOMAINS: 'A.example.com, b.example.com', SSO_REPAIR_BLOCK_DOMAINS: '*' });
    expect(c.blockDomains).toEqual(['a.example.com', 'b.example.com']);
    expect(c.repairBlockDomains).toBe('*');
  });

  it('sendActivationEmail defaults to FALSE (SSO activations stay silent)', () => {
    expect(parseConfig({ ...base }).sendActivationEmail).toBe(false);
  });

  it('sendActivationEmail honours truthy spellings', () => {
    for (const v of ['1', 'true', 'yes', 'on', 'TRUE']) {
      expect(parseConfig({ ...base, SSO_SEND_ACTIVATION_EMAIL: v }).sendActivationEmail).toBe(true);
    }
    for (const v of ['0', 'false', 'no', '', '  ']) {
      expect(parseConfig({ ...base, SSO_SEND_ACTIVATION_EMAIL: v }).sendActivationEmail).toBe(false);
    }
  });

  it('repairDomains defaults to empty (repair OFF)', () => {
    const c = parseConfig({ ...base });
    expect(c.repairDomains).toEqual([]);
  });

  it('repairDomains parses a comma list, lowercased', () => {
    const c = parseConfig({ ...base, SSO_REPAIR_DOMAINS: 'A.example.com, b.example.com' });
    expect(c.repairDomains).toEqual(['a.example.com', 'b.example.com']);
  });

  it('repairDomains honors the wildcard', () => {
    const c = parseConfig({ ...base, SSO_REPAIR_DOMAINS: '*' });
    expect(c.repairDomains).toBe('*');
  });
});

describe('domainInList', () => {
  it('* matches anything', () => expect(domainInList('*', 'x.y')).toBe(true));
  it('CSV matches case-insensitively', () => expect(domainInList(['x.y'], 'X.Y')).toBe(true));
  it('empty matches nothing', () => expect(domainInList([], 'x.y')).toBe(false));
});

describe('domainAllowed', () => {
  it('block always wins over allow', () => {
    expect(domainAllowed('*', ['d.example.com'], 'd.example.com')).toBe(false);
    expect(domainAllowed(['d.example.com'], ['d.example.com'], 'd.example.com')).toBe(false);
  });
  it('allows when on the allowlist and not blocked', () => {
    expect(domainAllowed('*', [], 'd.example.com')).toBe(true);
    expect(domainAllowed(['d.example.com'], ['other.example.com'], 'd.example.com')).toBe(true);
  });
  it('an empty allowlist permits nothing, blocklist irrelevant', () => {
    expect(domainAllowed([], [], 'd.example.com')).toBe(false);
  });
});

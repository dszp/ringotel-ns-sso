import { describe, it, expect } from 'vitest';
import { domainAllowed, extBlocked, parseConfig, domainInList, ConfigError, type Env } from './config.js';

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
    expect(c.eligibility.excludeNames).toEqual(['shared', 'shared voicemail', 'voicemail', 'fax', 'general', 'conference', 'conf rm', 'conf room', 'routing']);
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

describe('seeded name exclusions', () => {
  // The matcher is SUBSTRING and case-insensitive, which is why the seeded list carries the short forms:
  // 'general' catches "General Voicemail". 'conference' is spelled out on purpose — 'conf' would also
  // match surnames. Pinned here so the two repos' seeds can't drift apart unnoticed.
  const seeded = parseConfig({ ...base }).eligibility.excludeNames;
  const matches = (name: string) => seeded.some((m) => name.toLowerCase().includes(m));

  it('catches the long forms via their short prefixes', () => {
    for (const n of ['General Voicemail', 'GENERAL', 'Conference Room', 'Conf Rm 2', 'CONF ROOM B', 'Routing', 'Shared Voicemail', 'Fax Line']) {
      expect(matches(n)).toBe(true);
    }
  });

  it('leaves ordinary names alone', () => {
    for (const n of ['Dana Reed', 'Sales Desk', 'Front Office']) expect(matches(n)).toBe(false);
  });

  it('an explicitly EMPTY env value means no exclusions at all, overriding the seed', () => {
    // Not a typo-guard: "" is a deliberate opt-out, and it is why a deployment can silently end up with
    // no name exclusions while the code still ships a sensible default.
    expect(parseConfig({ ...base, RINGOTEL_EXCLUDE_NAMES: '' }).eligibility.excludeNames).toEqual([]);
  });
});

describe('SSO_BLOCK_EXTS — no device, ever', () => {
  // Distinct from the soft RINGOTEL_EXCLUDE_EXTS: that one gates auto-creation only, so a heal or a
  // repair would still create the device. This list blocks every device-creating path.
  const cfg = (over: Partial<Env> = {}) => parseConfig({ ...base, ...over });

  it('defaults to nothing blocked', () => {
    expect(cfg().blockExts).toEqual([]);
    expect(cfg().blockExtsByDomain).toEqual({});
  });

  it('blocks a listed extension on any domain', () => {
    const c = cfg({ SSO_BLOCK_EXTS: '900' });
    expect(extBlocked('900', 'a.12345.service', c)).toBe(true);
    expect(extBlocked('901', 'a.12345.service', c)).toBe(false);
  });

  it('supports a prefix wildcard', () => {
    const c = cfg({ SSO_BLOCK_EXTS: '90*' });
    expect(extBlocked('900', 'a.12345.service', c)).toBe(true);
    expect(extBlocked('9012', 'a.12345.service', c)).toBe(true);
    expect(extBlocked('8000', 'a.12345.service', c)).toBe(false);
  });

  it('per-domain remove permits it on exactly one domain — the whole point', () => {
    const c = cfg({ SSO_BLOCK_EXTS: '900', SSO_BLOCK_EXTS_BY_DOMAIN: '{"one.12345.service":{"remove":["900"]}}' });
    expect(extBlocked('900', 'one.12345.service', c)).toBe(false);
    expect(extBlocked('900', 'other.12345.service', c)).toBe(true);
  });

  it('per-domain add blocks an extra extension on one domain only', () => {
    const c = cfg({ SSO_BLOCK_EXTS_BY_DOMAIN: '{"one.12345.service":{"add":["8000"]}}' });
    expect(extBlocked('8000', 'one.12345.service', c)).toBe(true);
    expect(extBlocked('8000', 'other.12345.service', c)).toBe(false);
  });

  it('domain matching is case-insensitive', () => {
    const c = cfg({ SSO_BLOCK_EXTS: '900', SSO_BLOCK_EXTS_BY_DOMAIN: '{"one.12345.service":{"remove":["900"]}}' });
    expect(extBlocked('900', 'ONE.12345.SERVICE', c)).toBe(false);
  });

  it('rejects malformed JSON rather than silently blocking nothing', () => {
    expect(() => cfg({ SSO_BLOCK_EXTS_BY_DOMAIN: 'not json' })).toThrow(/not valid JSON/);
    expect(() => cfg({ SSO_BLOCK_EXTS_BY_DOMAIN: '{"d":{"add":"900"}}' })).toThrow(/add\/remove/);
  });
});

describe('extBlocked — wildcard and per-domain interaction (regression)', () => {
  const cfg = (over: Partial<Env> = {}) => parseConfig({ ...base, ...over });

  it('a per-domain remove exempts an extension matched by a WILDCARD block', () => {
    // Regression: `remove` used to be set-subtraction, so deleting the literal "900" from a list
    // containing the pattern "90*" was a no-op — the exempt domain stayed blocked, silently.
    const c = cfg({ SSO_BLOCK_EXTS: '90*', SSO_BLOCK_EXTS_BY_DOMAIN: '{"one.12345.service":{"remove":["900"]}}' });
    expect(extBlocked('900', 'one.12345.service', c)).toBe(false);
    expect(extBlocked('901', 'one.12345.service', c)).toBe(true);
    expect(extBlocked('900', 'other.12345.service', c)).toBe(true);
  });

  it('a wildcard REMOVE exempts a range from an exact block', () => {
    const c = cfg({ SSO_BLOCK_EXTS: '900,901', SSO_BLOCK_EXTS_BY_DOMAIN: '{"one.12345.service":{"remove":["90*"]}}' });
    expect(extBlocked('900', 'one.12345.service', c)).toBe(false);
    expect(extBlocked('901', 'one.12345.service', c)).toBe(false);
  });

  it('remove beats add within the same domain entry', () => {
    const c = cfg({ SSO_BLOCK_EXTS_BY_DOMAIN: '{"one.12345.service":{"add":["90*"],"remove":["900"]}}' });
    expect(extBlocked('900', 'one.12345.service', c)).toBe(false);
    expect(extBlocked('901', 'one.12345.service', c)).toBe(true);
  });

  it('whitespace in the JSON arrays does not break matching', () => {
    const c = cfg({ SSO_BLOCK_EXTS_BY_DOMAIN: '{"one.12345.service":{"add":[" 900 "]}}' });
    expect(extBlocked('900', 'one.12345.service', c)).toBe(true);
  });
});

describe('per-domain overrides fail CLOSED on a typo', () => {
  const cfg = (v: string) => () => parseConfig({ ...base, SSO_BLOCK_EXTS_BY_DOMAIN: v });
  it('rejects an unknown key rather than silently blocking nothing', () =>
    expect(cfg('{"d.12345.service":{"ad":["900"]}}')).toThrow(/unknown key/));
  it('rejects the same value in both add and remove', () =>
    expect(cfg('{"d.12345.service":{"add":["900"],"remove":["900"]}}')).toThrow(/both add and remove/));
});

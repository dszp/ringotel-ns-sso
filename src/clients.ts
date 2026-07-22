import { NsAuthClient, NsAuthError, NsClient, NsWriteClient, type Rec } from '@dszp/netsapiens-lib';
import { RingotelReadClient, RingotelWriteClient } from '@dszp/ringotel-lib';
import type { Config } from './config.js';
import type { AuthorizeDeps } from './authorize.js';
import { cachedOrganizations, type CacheLike } from './orgCache.js';

/** Build the real dependency set for `authorize` from validated config. */
export function buildDeps(
  config: Config,
  fetchImpl: typeof fetch = fetch,
  /** Worker-only plumbing for the org-list cache. Omitted (e.g. in tests) ⇒ every read is live. */
  cacheOpts: { cache?: CacheLike; waitUntil?: (p: Promise<unknown>) => void } = {},
): AuthorizeDeps {
  const nsAuth = new NsAuthClient({
    server: config.nsOauthServer,
    clientId: config.oauthClientId,
    clientSecret: config.oauthClientSecret,
    fetchImpl,
  });

  // Authenticate with the CALLER's own credentials, then read their NS self-record with their OWN
  // token — least privilege: no admin/API-key identity is ever used to look up the caller's identity.
  // The literal `~` in the path is NS's wildcard for "the token's own domain/user" — do NOT
  // URL-encode it.
  const auth = {
    authenticate: async (u: string, p: string) => {
      let grant;
      try {
        grant = await nsAuth.passwordGrant(u, p);
      } catch (e) {
        if (e instanceof NsAuthError && e.status >= 400 && e.status < 500) return { ok: false };
        throw e; // 5xx / network → fail closed upstream
      }
      const token = String(grant.access_token ?? '');
      if (!token) return { ok: false };
      const userClient = new NsClient({ server: config.nsServer, token, fetchImpl });
      const self = await userClient.get<Rec>('/domains/~/users/~');
      return { ok: true, self };
    },
  };

  const rt = new RingotelReadClient({ token: config.ringotelToken, injectOrgId: false, fetchImpl });
  // Only the org list is cached, and only for seconds — it is the fleet-wide read an UNAUTHENTICATED
  // request can reach (resolving a bare extension precedes the credential check). Branch and user reads
  // stay live. `read` keeps the same shape either way, so nothing downstream knows the difference.
  const getOrganizations = cachedOrganizations(() => rt.getOrganizations(), {
    ...cacheOpts,
    token: config.ringotelToken,
    ttl: config.orgCacheTtl,
  });
  const read = {
    getOrganizations,
    getBranches: (orgid: string) => rt.getBranches(orgid),
    getUsers: (orgid: string, branchid?: string) => rt.getUsers(orgid, branchid),
  };

  const getWrite = async () => {
    let nsToken: string;
    if (config.writeIdentity.kind === 'api') {
      nsToken = config.writeIdentity.token;
    } else {
      const grant = await nsAuth.passwordGrant(config.writeIdentity.user, config.writeIdentity.pass);
      nsToken = String(grant.access_token ?? '');
      if (!nsToken) throw new Error('admin OAuth returned no access_token');
    }
    return {
      rt: new RingotelWriteClient({ token: config.ringotelToken, fetchImpl }),
      ns: new NsWriteClient({ server: config.nsServer, token: nsToken, fetchImpl }),
    };
  };

  return { config, auth, read, getWrite };
}

/**
 * The enclave's own Keycloak (SEC-12, ADR-0036). Realm `cjis` only; nothing
 * is federated with the platform realms. Two ways in:
 * - provisioning signs in to the master realm with the bootstrap admin and
 *   builds the realm, its flows and clients (idempotent);
 * - the enclave worker uses the least-privilege service account
 *   `cjis-api-admin` (manage and view users, view events) for onboarding,
 *   suspension and copying sign-in events into the enclave audit.
 *
 * Every authenticator in the flows carries an authentication method reference
 * (`pwd`, `hwk`, `otp`), and the AMR mapper puts them in the token, so the API
 * can refuse a token whose sign-in skipped the second factor (fail closed).
 */
export type AdminAuth =
  | { kind: 'master'; user: string; password: string }
  | { kind: 'client'; realm: string; clientId: string; secret: string };

export interface EnclaveRealmSpec {
  realm: string;
  displayName: string;
  /** Where browsers reach the enclave gateway, e.g. https://localhost:8443 */
  publicUrl: string;
  adminClientSecret: string;
  /** Synthetic stacks only: the direct-grant test client and the Vite dev origin. */
  devAccounts: boolean;
}

export const DEV_TEST_CLIENT = { clientId: 'cjis-tests', secret: 'cjis-tests-dev-secret' } as const;
export const WEB_CLIENT_ID = 'cjis-web';
export const ADMIN_CLIENT_ID = 'cjis-api-admin';
export const API_AUDIENCE = 'cjis-api';

/** Sign-in event types copied into the enclave audit (AU-2). */
export const AUDITED_EVENT_TYPES = [
  'LOGIN',
  'LOGIN_ERROR',
  'LOGOUT',
  'LOGOUT_ERROR',
  'CODE_TO_TOKEN',
  'CODE_TO_TOKEN_ERROR',
  'REFRESH_TOKEN_ERROR',
  'UPDATE_PASSWORD',
  'UPDATE_PASSWORD_ERROR',
  'UPDATE_CREDENTIAL',
  'REMOVE_CREDENTIAL',
  'USER_DISABLED_BY_TEMPORARY_LOCKOUT',
  'USER_DISABLED_BY_PERMANENT_LOCKOUT',
] as const;

export interface IdpEvent {
  time: number;
  type: string;
  userId?: string;
  ipAddress?: string;
  error?: string;
  clientId?: string;
  sessionId?: string;
}

export class EnclaveKeycloak {
  private token: { value: string; expiresAt: number } | null = null;
  private readonly base: string;
  private readonly auth: AdminAuth;

  constructor(base: string, auth: AdminAuth) {
    this.base = base.replace(/\/$/, '');
    this.auth = auth;
  }

  private async adminToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 10_000) return this.token.value;
    const a = this.auth;
    const realm = a.kind === 'master' ? 'master' : a.realm;
    const body =
      a.kind === 'master'
        ? new URLSearchParams({
            grant_type: 'password',
            client_id: 'admin-cli',
            username: a.user,
            password: a.password,
          })
        : new URLSearchParams({
            grant_type: 'client_credentials',
            client_id: a.clientId,
            client_secret: a.secret,
          });
    const res = await fetch(`${this.base}/realms/${realm}/protocol/openid-connect/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!res.ok) throw new Error(`enclave identity admin token failed: HTTP ${res.status}`);
    const t = (await res.json()) as { access_token: string; expires_in: number };
    this.token = { value: t.access_token, expiresAt: Date.now() + t.expires_in * 1000 };
    return t.access_token;
  }

  async call(
    method: string,
    path: string,
    body?: unknown,
    allow: number[] = [],
  ): Promise<Response> {
    const res = await fetch(`${this.base}/admin/realms${path}`, {
      method,
      headers: {
        authorization: `Bearer ${await this.adminToken()}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok && !allow.includes(res.status)) {
      throw new Error(
        `enclave identity ${method} ${path.replace(/\/users\/[^/]+/, '/users/…')} failed: HTTP ${res.status} ${(await res.text()).slice(0, 160)}`,
      );
    }
    return res;
  }

  private async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    return (await (await this.call(method, path, body)).json()) as T;
  }

  /** Idempotent: realm, flows, required actions, clients and the admin client's roles. */
  async ensureRealm(spec: EnclaveRealmSpec): Promise<void> {
    const exists = (await this.call('GET', `/${spec.realm}`, undefined, [404])).ok;
    if (!exists) await this.call('POST', '', enclaveRealmTemplate(spec), [409]);
    // Settings are re-applied on every run, so a changed value reaches existing stacks.
    await this.call('PUT', `/${spec.realm}`, enclaveRealmSettings(spec));
    await this.ensureBrowserFlow(spec.realm);
    await this.ensureDirectGrantFlow(spec.realm);
    await this.ensureRequiredActions(spec.realm);
    await this.ensureWebClient(spec);
    await this.ensureAdminClient(spec);
    if (spec.devAccounts) await this.ensureTestClient(spec);
  }

  private async flowExists(realm: string, alias: string): Promise<boolean> {
    const flows = await this.json<{ alias: string }[]>('GET', `/${realm}/authentication/flows`);
    return flows.some((f) => f.alias === alias);
  }

  private async executions(realm: string, flow: string) {
    return this.json<
      {
        id: string;
        providerId?: string;
        displayName: string;
        requirement: string;
        level: number;
        authenticationConfig?: string;
      }[]
    >('GET', `/${realm}/authentication/flows/${encodeURIComponent(flow)}/executions`);
  }

  /** Authentication method reference on an execution, for the AMR claim (RFC 8176 values). */
  private async reference(realm: string, executionId: string, value: string): Promise<void> {
    await this.call(
      'POST',
      `/${realm}/authentication/executions/${executionId}/config`,
      {
        alias: `cjis-amr-${value}-${executionId.slice(0, 8)}`,
        config: { 'default.reference.value': value, 'default.reference.maxAge': '0' },
      },
      [409],
    );
  }

  /** Browser: cookie OR (password THEN passkey). Both factors carry a method reference. */
  private async ensureBrowserFlow(realm: string): Promise<void> {
    if (!(await this.flowExists(realm, 'cjis-browser'))) {
      await this.call('POST', `/${realm}/authentication/flows`, {
        alias: 'cjis-browser',
        description: 'Enclave sign-in: password then passkey (WebAuthn), both required',
        providerId: 'basic-flow',
        topLevel: true,
        builtIn: false,
      });
      await this.call('POST', `/${realm}/authentication/flows/cjis-browser/executions/execution`, {
        provider: 'auth-cookie',
      });
      await this.call('POST', `/${realm}/authentication/flows/cjis-browser/executions/flow`, {
        alias: 'cjis-forms',
        type: 'basic-flow',
        provider: 'registration-page-form',
        description: 'Password and passkey',
      });
      await this.call('POST', `/${realm}/authentication/flows/cjis-forms/executions/execution`, {
        provider: 'auth-username-password-form',
      });
      await this.call('POST', `/${realm}/authentication/flows/cjis-forms/executions/execution`, {
        provider: 'webauthn-authenticator',
      });
      for (const e of await this.executions(realm, 'cjis-browser')) {
        const requirement =
          e.providerId === 'auth-cookie' || e.displayName === 'cjis-forms'
            ? 'ALTERNATIVE'
            : 'REQUIRED';
        await this.call(
          'PUT',
          `/${realm}/authentication/flows/cjis-browser/executions`,
          { ...e, requirement },
          [202],
        );
      }
    }
    for (const e of await this.executions(realm, 'cjis-browser')) {
      if (e.authenticationConfig) continue;
      if (e.providerId === 'auth-username-password-form') await this.reference(realm, e.id, 'pwd');
      if (e.providerId === 'webauthn-authenticator') await this.reference(realm, e.id, 'hwk');
    }
    await this.call('PUT', `/${realm}`, { browserFlow: 'cjis-browser' });
  }

  /**
   * Direct grant: username, password and a one-time code, all required. Only
   * the development test client allows direct grants; in production no client
   * does, and the API does not count `otp` as a second factor there.
   */
  private async ensureDirectGrantFlow(realm: string): Promise<void> {
    if (!(await this.flowExists(realm, 'cjis-direct'))) {
      await this.call('POST', `/${realm}/authentication/flows`, {
        alias: 'cjis-direct',
        description: 'Development test client only: password and one-time code',
        providerId: 'basic-flow',
        topLevel: true,
        builtIn: false,
      });
      for (const provider of [
        'direct-grant-validate-username',
        'direct-grant-validate-password',
        'direct-grant-validate-otp',
      ]) {
        await this.call('POST', `/${realm}/authentication/flows/cjis-direct/executions/execution`, {
          provider,
        });
      }
      for (const e of await this.executions(realm, 'cjis-direct')) {
        await this.call(
          'PUT',
          `/${realm}/authentication/flows/cjis-direct/executions`,
          { ...e, requirement: 'REQUIRED' },
          [202],
        );
      }
    }
    for (const e of await this.executions(realm, 'cjis-direct')) {
      if (e.authenticationConfig) continue;
      if (e.providerId === 'direct-grant-validate-password')
        await this.reference(realm, e.id, 'pwd');
      if (e.providerId === 'direct-grant-validate-otp') await this.reference(realm, e.id, 'otp');
    }
    await this.call('PUT', `/${realm}`, { directGrantFlow: 'cjis-direct' });
  }

  private async ensureRequiredActions(realm: string): Promise<void> {
    await this.call('PUT', `/${realm}/authentication/required-actions/webauthn-register`, {
      alias: 'webauthn-register',
      name: 'Webauthn Register',
      providerId: 'webauthn-register',
      enabled: true,
      defaultAction: true,
      priority: 70,
      config: {},
    });
  }

  private async clientUuid(realm: string, clientId: string): Promise<string | undefined> {
    const list = await this.json<{ id: string }[]>(
      'GET',
      `/${realm}/clients?clientId=${encodeURIComponent(clientId)}`,
    );
    return list[0]?.id;
  }

  private async ensureWebClient(spec: EnclaveRealmSpec): Promise<void> {
    const body = {
      clientId: WEB_CLIENT_ID,
      name: 'CJIS enclave web app',
      publicClient: true,
      standardFlowEnabled: true,
      directAccessGrantsEnabled: false,
      implicitFlowEnabled: false,
      serviceAccountsEnabled: false,
      frontchannelLogout: true,
      redirectUris: spec.devAccounts
        ? [`${spec.publicUrl}/*`, 'http://localhost:5174/*']
        : [`${spec.publicUrl}/*`],
      webOrigins: spec.devAccounts ? [spec.publicUrl, 'http://localhost:5174'] : [spec.publicUrl],
      attributes: {
        'pkce.code.challenge.method': 'S256',
        'post.logout.redirect.uris': `${spec.publicUrl}/*`,
      },
      protocolMappers: tokenMappers(),
    };
    const id = await this.clientUuid(spec.realm, WEB_CLIENT_ID);
    if (!id) await this.call('POST', `/${spec.realm}/clients`, body, [409]);
    else {
      // Mappers are created with the client; an update keeps the ones in place.
      const rest: Partial<typeof body> = { ...body };
      delete rest.protocolMappers;
      await this.call('PUT', `/${spec.realm}/clients/${id}`, rest);
    }
  }

  private async ensureTestClient(spec: EnclaveRealmSpec): Promise<void> {
    if (await this.clientUuid(spec.realm, DEV_TEST_CLIENT.clientId)) return;
    await this.call(
      'POST',
      `/${spec.realm}/clients`,
      {
        clientId: DEV_TEST_CLIENT.clientId,
        name: 'Automated tests (development only)',
        publicClient: false,
        secret: DEV_TEST_CLIENT.secret,
        standardFlowEnabled: false,
        directAccessGrantsEnabled: true,
        serviceAccountsEnabled: false,
        protocolMappers: tokenMappers(),
      },
      [409],
    );
  }

  /** The worker's service account: users and events only, never realm settings. */
  private async ensureAdminClient(spec: EnclaveRealmSpec): Promise<void> {
    let id = await this.clientUuid(spec.realm, ADMIN_CLIENT_ID);
    if (!id) {
      await this.call(
        'POST',
        `/${spec.realm}/clients`,
        {
          clientId: ADMIN_CLIENT_ID,
          name: 'Enclave worker (users and sign-in events)',
          publicClient: false,
          secret: spec.adminClientSecret,
          standardFlowEnabled: false,
          directAccessGrantsEnabled: false,
          serviceAccountsEnabled: true,
        },
        [409],
      );
      id = await this.clientUuid(spec.realm, ADMIN_CLIENT_ID);
    } else {
      await this.call('PUT', `/${spec.realm}/clients/${id}`, {
        clientId: ADMIN_CLIENT_ID,
        secret: spec.adminClientSecret,
      });
    }
    if (!id) throw new Error('enclave admin client missing after creation');
    const sa = await this.json<{ id: string }>(
      'GET',
      `/${spec.realm}/clients/${id}/service-account-user`,
    );
    const rm = await this.clientUuid(spec.realm, 'realm-management');
    if (!rm) throw new Error('realm-management client missing');
    const available = await this.json<{ id: string; name: string }[]>(
      'GET',
      `/${spec.realm}/clients/${rm}/roles`,
    );
    const wanted = available.filter((r) =>
      ['manage-users', 'view-users', 'query-users', 'view-events'].includes(r.name),
    );
    await this.call(
      'POST',
      `/${spec.realm}/users/${sa.id}/role-mappings/clients/${rm}`,
      wanted,
      [204],
    );
  }

  async findUserByEmail(realm: string, email: string): Promise<string | undefined> {
    const found = await this.json<{ id: string }[]>(
      'GET',
      `/${realm}/users?email=${encodeURIComponent(email)}&exact=true`,
    );
    return found[0]?.id;
  }

  /**
   * Onboarding (plan §4): the account is created with a temporary password
   * handed over in person; at first sign-in the person sets a password and
   * registers a passkey.
   */
  async createUser(
    realm: string,
    user: { email: string; displayName: string; temporaryPassword: string },
  ): Promise<string> {
    const existing = await this.findUserByEmail(realm, user.email);
    if (existing) return existing;
    const [first, ...rest] = user.displayName.split(' ');
    const res = await this.call('POST', `/${realm}/users`, {
      username: user.email,
      email: user.email,
      emailVerified: true,
      enabled: true,
      firstName: first ?? user.displayName,
      lastName: rest.join(' ') || '-',
      requiredActions: ['UPDATE_PASSWORD', 'webauthn-register'],
      credentials: [{ type: 'password', value: user.temporaryPassword, temporary: true }],
    });
    const id = (res.headers.get('location') ?? '').split('/').pop();
    if (!id) throw new Error('enclave identity did not return the new user id');
    return id;
  }

  /**
   * Synthetic stacks only: an exercise account with the development password
   * and a one-time-code credential for the test client (never a production path).
   */
  async ensureDevUser(
    realm: string,
    user: { email: string; displayName: string; password: string; otpSecret: string },
  ): Promise<string> {
    let id = await this.findUserByEmail(realm, user.email);
    const [first, ...rest] = user.displayName.split(' ');
    const representation = {
      username: user.email,
      email: user.email,
      emailVerified: true,
      enabled: true,
      firstName: first ?? user.displayName,
      lastName: rest.join(' ') || '-',
      requiredActions: [],
    };
    let changed = false;
    if (!id) {
      const res = await this.call('POST', `/${realm}/users`, representation);
      id = (res.headers.get('location') ?? '').split('/').pop();
      if (!id) throw new Error('enclave identity did not return the new user id');
      changed = true;
    }
    const creds = await this.json<{ type: string }[]>('GET', `/${realm}/users/${id}/credentials`);
    if (!creds.some((c) => c.type === 'otp')) {
      changed = true;
      await this.call('POST', `/${realm}/partialImport`, {
        ifResourceExists: 'OVERWRITE',
        users: [
          {
            id,
            ...representation,
            credentials: [
              {
                type: 'otp',
                userLabel: 'development test client',
                secretData: JSON.stringify({ value: user.otpSecret }),
                credentialData: JSON.stringify({
                  subType: 'totp',
                  digits: 6,
                  period: 30,
                  algorithm: 'HmacSHA1',
                  counter: 0,
                }),
              },
            ],
          },
        ],
      });
    }
    // The import replaces the credentials it names and leaves the password unusable;
    // set the password last, and only when something changed (the realm refuses a
    // password from its last ten).
    if (changed || !creds.some((c) => c.type === 'password')) {
      await this.call('PUT', `/${realm}/users/${id}/reset-password`, {
        type: 'password',
        value: user.password,
        temporary: false,
      });
      await this.call('PUT', `/${realm}/users/${id}`, { requiredActions: [] });
    }
    return id;
  }

  async setEnabled(realm: string, userId: string, enabled: boolean): Promise<void> {
    await this.call('PUT', `/${realm}/users/${userId}`, { enabled });
    if (!enabled) await this.call('POST', `/${realm}/users/${userId}/logout`, undefined, [404]);
  }

  async events(realm: string, sinceMs: number, max = 200): Promise<IdpEvent[]> {
    const params = new URLSearchParams({ max: String(max), first: '0' });
    for (const t of AUDITED_EVENT_TYPES) params.append('type', t);
    // dateFrom is day-granular in Keycloak; the caller filters by time.
    params.set('dateFrom', new Date(sinceMs).toISOString().slice(0, 10));
    const list = await this.json<IdpEvent[]>('GET', `/${realm}/events?${params.toString()}`);
    return list.filter((e) => e.time > sinceMs).sort((a, b) => a.time - b.time);
  }
}

function tokenMappers() {
  return [
    {
      name: 'amr',
      protocol: 'openid-connect',
      protocolMapper: 'oidc-amr-mapper',
      config: { 'access.token.claim': 'true', 'id.token.claim': 'true' },
    },
    {
      name: 'audience cjis-api',
      protocol: 'openid-connect',
      protocolMapper: 'oidc-audience-mapper',
      config: {
        'included.custom.audience': API_AUDIENCE,
        'access.token.claim': 'true',
        'id.token.claim': 'false',
      },
    },
  ];
}

/**
 * Configured CJIS values (layer-5 plan §4, ADR-0036): five failed sign-ins in
 * 15 minutes lock the account for 10 minutes; the session ends after 30
 * minutes without activity; passwords of at least 15 characters, not the
 * username or email, last 10 not reused; no self-registration, no reset by
 * email (the enclave sends no email); sign-in and admin events recorded.
 */
export function enclaveRealmSettings(spec: EnclaveRealmSpec) {
  return {
    displayName: spec.displayName,
    enabled: true,
    sslRequired: 'external',
    registrationAllowed: false,
    loginWithEmailAllowed: true,
    duplicateEmailsAllowed: false,
    resetPasswordAllowed: false,
    rememberMe: false,
    verifyEmail: false,
    bruteForceProtected: true,
    permanentLockout: false,
    failureFactor: 5,
    maxDeltaTimeSeconds: 900,
    waitIncrementSeconds: 600,
    maxFailureWaitSeconds: 600,
    minimumQuickLoginWaitSeconds: 60,
    accessTokenLifespan: 300,
    ssoSessionIdleTimeout: 1800,
    ssoSessionMaxLifespan: 36_000,
    clientSessionIdleTimeout: 1800,
    offlineSessionIdleTimeout: 1800,
    passwordPolicy: 'length(15) and notUsername and notEmail and passwordHistory(10)',
    internationalizationEnabled: false,
    webAuthnPolicyRpEntityName: spec.displayName,
    webAuthnPolicyUserVerificationRequirement: 'required',
    webAuthnPolicyRequireResidentKey: 'not specified',
    webAuthnPolicyAuthenticatorAttachment: 'not specified',
    webAuthnPolicySignatureAlgorithms: ['ES256', 'RS256'],
    eventsEnabled: true,
    eventsExpiration: 30 * 24 * 3600,
    enabledEventTypes: [...AUDITED_EVENT_TYPES],
    adminEventsEnabled: true,
    adminEventsDetailsEnabled: false,
  };
}

export function enclaveRealmTemplate(spec: EnclaveRealmSpec) {
  return { realm: spec.realm, ...enclaveRealmSettings(spec) };
}

/**
 * Keycloak admin client (ADR-0008, SEC-07). One realm per tenant, created
 * from `realmTemplate`: passkey (WebAuthn) required as the second factor on
 * the browser flow, the `cg_tenant_id` claim every token carries, the
 * console as a public PKCE client, SMTP pointed at the mail adapter. The
 * CJIS enclave uses a separate Keycloak and never this client (layer 5).
 */
export interface KeycloakSettings {
  adminBase: string; // e.g. http://idp:8080/auth
  adminUser: string;
  adminPassword: string;
}

export interface RealmSpec {
  slug: string;
  tenantId: string;
  displayName: string;
  locales: string[];
  consoleRedirect: string; // https://host/console/*
  consoleOrigin: string; // https://host
  smtp: { host: string; port: number; from: string };
  /** Dev/test only: a confidential client with direct-access grants for automated tests. */
  devDirectGrant: boolean;
}

export class KeycloakAdmin {
  private token: { value: string; expiresAt: number } | null = null;
  private readonly settings: KeycloakSettings;

  constructor(settings: KeycloakSettings) {
    this.settings = settings;
  }

  private async adminToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 10_000) return this.token.value;
    const res = await fetch(
      `${this.settings.adminBase}/realms/master/protocol/openid-connect/token`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'password',
          client_id: 'admin-cli',
          username: this.settings.adminUser,
          password: this.settings.adminPassword,
        }),
      },
    );
    if (!res.ok) throw new Error(`keycloak admin token failed: HTTP ${res.status}`);
    const body = (await res.json()) as { access_token: string; expires_in: number };
    this.token = { value: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
    return body.access_token;
  }

  private async call(method: string, path: string, body?: unknown): Promise<Response> {
    const res = await fetch(`${this.settings.adminBase}/admin/realms${path}`, {
      method,
      headers: {
        authorization: `Bearer ${await this.adminToken()}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return res;
  }

  private async ok(
    method: string,
    path: string,
    body?: unknown,
    allow: number[] = [],
  ): Promise<Response> {
    const res = await this.call(method, path, body);
    if (!res.ok && !allow.includes(res.status)) {
      throw new Error(
        `keycloak ${method} ${path} failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`,
      );
    }
    return res;
  }

  async realmExists(slug: string): Promise<boolean> {
    return (await this.call('GET', `/${slug}`)).ok;
  }

  /** Idempotent: creates the realm, flow, client and mapper if missing. */
  async ensureRealm(spec: RealmSpec): Promise<void> {
    if (!(await this.realmExists(spec.slug))) {
      await this.ok('POST', '', realmTemplate(spec), [409]);
    }
    await this.ensureBrowserFlow(spec.slug);
    await this.ensureConsoleClient(spec);
    if (spec.devDirectGrant) await this.ensureTestClient(spec);
  }

  /** Browser flow: cookie OR (password form THEN passkey). Phishing-resistant second factor (SEC-07). */
  private async ensureBrowserFlow(slug: string): Promise<void> {
    const flows = (await (await this.ok('GET', `/${slug}/authentication/flows`)).json()) as {
      alias: string;
    }[];
    if (!flows.some((f) => f.alias === 'cg-browser')) {
      await this.ok('POST', `/${slug}/authentication/flows`, {
        alias: 'cg-browser',
        description: 'Password then passkey (WebAuthn) as required second factor',
        providerId: 'basic-flow',
        topLevel: true,
        builtIn: false,
      });
      await this.ok('POST', `/${slug}/authentication/flows/cg-browser/executions/execution`, {
        provider: 'auth-cookie',
      });
      await this.ok('POST', `/${slug}/authentication/flows/cg-browser/executions/flow`, {
        alias: 'cg-forms',
        type: 'basic-flow',
        provider: 'registration-page-form',
        description: 'Forms',
      });
      await this.ok('POST', `/${slug}/authentication/flows/cg-forms/executions/execution`, {
        provider: 'auth-username-password-form',
      });
      await this.ok('POST', `/${slug}/authentication/flows/cg-forms/executions/execution`, {
        provider: 'webauthn-authenticator',
      });
      const execs = (await (
        await this.ok('GET', `/${slug}/authentication/flows/cg-browser/executions`)
      ).json()) as {
        id: string;
        providerId?: string;
        displayName: string;
        requirement: string;
        level: number;
      }[];
      for (const e of execs) {
        const requirement =
          e.providerId === 'auth-cookie' || e.displayName === 'cg-forms'
            ? 'ALTERNATIVE'
            : 'REQUIRED';
        await this.ok(
          'PUT',
          `/${slug}/authentication/flows/cg-browser/executions`,
          { ...e, requirement },
          [202],
        );
      }
      await this.ok('PUT', `/${slug}`, { browserFlow: 'cg-browser' });
    }
    // Passkey registration is a default required action on first login.
    await this.ok('PUT', `/${slug}/authentication/required-actions/webauthn-register`, {
      alias: 'webauthn-register',
      name: 'Webauthn Register',
      providerId: 'webauthn-register',
      enabled: true,
      defaultAction: true,
      priority: 70,
      config: {},
    });
  }

  private async clientByClientId(
    slug: string,
    clientId: string,
  ): Promise<{ id: string } | undefined> {
    const list = (await (
      await this.ok('GET', `/${slug}/clients?clientId=${encodeURIComponent(clientId)}`)
    ).json()) as { id: string }[];
    return list[0];
  }

  private async ensureConsoleClient(spec: RealmSpec): Promise<void> {
    if (!(await this.clientByClientId(spec.slug, 'cg-console'))) {
      await this.ok(
        'POST',
        `/${spec.slug}/clients`,
        {
          clientId: 'cg-console',
          name: 'Staff console',
          publicClient: true,
          standardFlowEnabled: true,
          directAccessGrantsEnabled: false,
          implicitFlowEnabled: false,
          serviceAccountsEnabled: false,
          redirectUris: [spec.consoleRedirect],
          webOrigins: [spec.consoleOrigin],
          attributes: {
            'pkce.code.challenge.method': 'S256',
            'post.logout.redirect.uris': spec.consoleRedirect,
          },
          protocolMappers: [tenantClaimMapper(spec.tenantId)],
        },
        [409],
      );
    }
  }

  private async ensureTestClient(spec: RealmSpec): Promise<void> {
    if (await this.clientByClientId(spec.slug, 'cg-tests')) return;
    await this.ok(
      'POST',
      `/${spec.slug}/clients`,
      {
        clientId: 'cg-tests',
        name: 'Automated tests (development only)',
        publicClient: false,
        secret: 'cg-tests-dev-secret',
        standardFlowEnabled: false,
        directAccessGrantsEnabled: true,
        serviceAccountsEnabled: false,
        protocolMappers: [tenantClaimMapper(spec.tenantId)],
      },
      [409],
    );
  }

  async ensureUser(
    slug: string,
    user: { email: string; displayName: string; enabled: boolean; devPassword?: string },
  ): Promise<string> {
    const found = (await (
      await this.ok('GET', `/${slug}/users?email=${encodeURIComponent(user.email)}&exact=true`)
    ).json()) as { id: string }[];
    let id = found[0]?.id;
    if (!id) {
      const [first, ...rest] = user.displayName.split(' ');
      const created = await this.ok('POST', `/${slug}/users`, {
        username: user.email,
        email: user.email,
        emailVerified: false,
        enabled: user.enabled,
        firstName: first ?? user.displayName,
        lastName: rest.join(' ') || '-',
                // Dev seed users get no pending required action: Keycloak refuses
        // direct-grant tokens otherwise. The browser flow still demands a
        // passkey, and registers one on first login when none exists.
        requiredActions: user.devPassword ? [] : ['UPDATE_PASSWORD', 'webauthn-register'],
        ...(user.devPassword
          ? { credentials: [{ type: 'password', value: user.devPassword, temporary: false }] }
          : {}),
      });
      const location = created.headers.get('location') ?? '';
      id = location.split('/').pop() ?? '';
      if (!id) throw new Error('keycloak did not return the new user id');
    }
    return id;
  }

  async setUserEnabled(slug: string, userId: string, enabled: boolean): Promise<void> {
    await this.ok('PUT', `/${slug}/users/${userId}`, { enabled });
    if (!enabled) await this.ok('POST', `/${slug}/users/${userId}/logout`, undefined, [404]);
  }

  /** Keycloak sends the invitation (set password, register passkey) through the realm SMTP. */
  async sendInvitation(slug: string, userId: string, redirectUri: string): Promise<void> {
    await this.ok(
      'PUT',
      `/${slug}/users/${userId}/execute-actions-email?client_id=cg-console&redirect_uri=${encodeURIComponent(redirectUri)}&lifespan=${7 * 24 * 3600}`,
      ['UPDATE_PASSWORD', 'webauthn-register'],
    );
  }
}

function tenantClaimMapper(tenantId: string) {
  return {
    name: 'cg_tenant_id',
    protocol: 'openid-connect',
    protocolMapper: 'oidc-hardcoded-claim-mapper',
    config: {
      'claim.name': 'cg_tenant_id',
      'claim.value': tenantId,
      'jsonType.label': 'String',
      'access.token.claim': 'true',
      'id.token.claim': 'true',
      'userinfo.token.claim': 'false',
    },
  };
}

export function realmTemplate(spec: RealmSpec) {
  return {
    realm: spec.slug,
    displayName: spec.displayName,
    enabled: true,
    sslRequired: 'external',
    registrationAllowed: false,
    loginWithEmailAllowed: true,
    duplicateEmailsAllowed: false,
    resetPasswordAllowed: true,
    rememberMe: false,
    bruteForceProtected: true,
    permanentLockout: false,
    failureFactor: 8,
    waitIncrementSeconds: 60,
    maxFailureWaitSeconds: 900,
    internationalizationEnabled: true,
    supportedLocales: spec.locales,
    defaultLocale: spec.locales[0] ?? 'en',
    accessTokenLifespan: 900,
    ssoSessionIdleTimeout: 1800,
    ssoSessionMaxLifespan: 36_000,
    passwordPolicy: 'length(12) and notUsername and notEmail',
    // Passkey (WebAuthn) policy: platform or roaming authenticators, user verification required.
    webAuthnPolicyRpEntityName: spec.displayName,
    webAuthnPolicyUserVerificationRequirement: 'required',
    webAuthnPolicyRequireResidentKey: 'not specified',
    webAuthnPolicyAuthenticatorAttachment: 'not specified',
    webAuthnPolicySignatureAlgorithms: ['ES256', 'RS256'],
    smtpServer: {
      host: spec.smtp.host,
      port: String(spec.smtp.port),
      from: spec.smtp.from,
      auth: 'false',
      ssl: 'false',
      starttls: 'false',
    },
    attributes: { cg_tenant_id: spec.tenantId },
  };
}

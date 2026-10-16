import { describe, expect, it } from 'vitest';
import {
  oidcProviderConfig,
  samlProviderConfig,
  ssoProviderRepresentation,
  SSO_ALIAS,
} from '../src/idp/keycloak.ts';

describe("SEC-07: the county's identity provider on its realm", () => {
  it('links to invited accounts only and asks for the passkey after the county sign-in', () => {
    const rep = ssoProviderRepresentation('Westwind County account', 'saml', {});
    expect(rep).toMatchObject({
      alias: SSO_ALIAS,
      providerId: 'saml',
      enabled: true,
      trustEmail: false,
      storeToken: false,
      firstBrokerLoginFlowAlias: 'cg-first-broker',
      postBrokerLoginFlowAlias: 'cg-post-broker',
    });
  });

  it('SAML: signed assertions and signature checks stay on whatever the metadata says', () => {
    const config = samlProviderConfig({
      singleSignOnServiceUrl: 'https://idp.example.gov/saml',
      validateSignature: 'false',
      wantAssertionsSigned: 'false',
      nameIDPolicyFormat: 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent',
    });
    expect(config).toMatchObject({
      singleSignOnServiceUrl: 'https://idp.example.gov/saml',
      validateSignature: 'true',
      wantAssertionsSigned: 'true',
      nameIDPolicyFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
      syncMode: 'IMPORT',
    });
  });

  it('OIDC: PKCE, signed tokens checked against the published keys', () => {
    const config = oidcProviderConfig({
      protocol: 'oidc',
      displayName: 'Westwind County account',
      issuer: 'https://idp.example.gov',
      authorizationUrl: 'https://idp.example.gov/authorize',
      tokenUrl: 'https://idp.example.gov/token',
      jwksUrl: 'https://idp.example.gov/keys',
      clientId: 'common-ground',
      clientSecret: 'exercise',
    });
    expect(config).toMatchObject({
      pkceEnabled: 'true',
      pkceMethod: 'S256',
      validateSignature: 'true',
      useJwksUrl: 'true',
      jwksUrl: 'https://idp.example.gov/keys',
      defaultScope: 'openid email profile',
    });
  });
});

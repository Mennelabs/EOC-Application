/**
 * Checks on a county's identity provider settings before anyone approves
 * them (SEC-07). SAML metadata is parsed by Keycloak, which refuses external
 * entities; here it is only screened: a size cap, no document type
 * declarations or entities at all, and the parts a sign-in needs (an entity
 * id, a single sign-on address and a signing certificate). OIDC addresses
 * must be https without credentials in them.
 */
export const SSO_ALIAS = 'county-sso';
export const SAML_METADATA_MAX = 200_000;

export function httpsUrlProblem(value: string): string | null {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return 'Enter a full address starting with https://';
  }
  if (u.protocol !== 'https:') return 'The address must start with https://';
  if (u.username || u.password) return 'The address must not carry a user name or password';
  if (value.length > 500) return 'The address is longer than 500 characters';
  return null;
}

export interface SamlScreen {
  problem: string | null;
  entityId: string | null;
}

export function screenSamlMetadata(xml: string): SamlScreen {
  const fail = (problem: string): SamlScreen => ({ problem, entityId: null });
  if (xml.length > SAML_METADATA_MAX) return fail('The metadata is larger than 200 KB');
  if (/<!DOCTYPE|<!ENTITY/i.test(xml))
    return fail('The metadata must not contain a document type declaration or entities');
  const entity = /<(?:[\w-]+:)?EntityDescriptor\b[^>]*\bentityID\s*=\s*"([^"]{1,500})"/.exec(xml);
  if (!entity) return fail('No EntityDescriptor with an entityID was found');
  if (!/<(?:[\w-]+:)?IDPSSODescriptor\b/.test(xml))
    return fail('This is not identity provider metadata (no IDPSSODescriptor)');
  if (!/<(?:[\w-]+:)?SingleSignOnService\b/.test(xml))
    return fail('The metadata has no single sign-on address (SingleSignOnService)');
  if (!/<(?:[\w-]+:)?X509Certificate\b/.test(xml))
    return fail('The metadata has no signing certificate (X509Certificate)');
  return { problem: null, entityId: entity[1]! };
}

/** What the county gives its identity provider, from the realm's public address. */
export function serviceProvider(idpPublicBase: string, slug: string) {
  const realm = `${idpPublicBase.replace(/\/+$/, '')}/realms/${encodeURIComponent(slug)}`;
  const endpoint = `${realm}/broker/${SSO_ALIAS}/endpoint`;
  return {
    entityId: realm,
    redirectUri: endpoint,
    metadataUrl: `${endpoint}/descriptor`,
  };
}

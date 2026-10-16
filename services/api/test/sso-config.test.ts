import { describe, expect, it } from 'vitest';
import { httpsUrlProblem, screenSamlMetadata, serviceProvider } from '../src/sso-config.ts';

const good = `<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="https://idp.example.gov/saml">
  <md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <md:KeyDescriptor use="signing"><ds:KeyInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:X509Data><ds:X509Certificate>MIIB</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>
    <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://idp.example.gov/saml"/>
  </md:IDPSSODescriptor>
</md:EntityDescriptor>`;

describe('SEC-07: screening a county identity provider', () => {
  it('reads the entity id from identity provider metadata, with or without a namespace prefix', () => {
    expect(screenSamlMetadata(good)).toEqual({
      problem: null,
      entityId: 'https://idp.example.gov/saml',
    });
    expect(screenSamlMetadata(good.replace(/md:/g, '')).entityId).toBe(
      'https://idp.example.gov/saml',
    );
  });

  it('refuses entities and document types, service provider metadata, and missing parts', () => {
    expect(screenSamlMetadata(`<!DOCTYPE x>${good}`).problem).toMatch(/document type/);
    expect(screenSamlMetadata(`<!ENTITY e "x">${good}`).problem).toMatch(/document type/);
    expect(
      screenSamlMetadata(good.replace(/IDPSSODescriptor/g, 'SPSSODescriptor')).problem,
    ).toMatch(/not identity provider metadata/);
    expect(screenSamlMetadata(good.replace(/X509Certificate/g, 'Nothing')).problem).toMatch(
      /signing certificate/,
    );
    expect(screenSamlMetadata(good.replace(/SingleSignOnService/g, 'Other')).problem).toMatch(
      /single sign-on address/,
    );
    expect(screenSamlMetadata(good.replace(/entityID="[^"]*"/, '')).problem).toMatch(/entityID/);
    expect(screenSamlMetadata(good + ' '.repeat(200_001)).problem).toMatch(/200 KB/);
  });

  it('takes only https addresses without credentials', () => {
    expect(httpsUrlProblem('https://idp.example.gov/token')).toBeNull();
    expect(httpsUrlProblem('http://idp.example.gov/token')).toMatch(/https/);
    expect(httpsUrlProblem('https://user:pw@idp.example.gov/token')).toMatch(/user name/);
    expect(httpsUrlProblem('idp.example.gov')).toMatch(/full address/);
  });

  it("names the county realm's service provider addresses", () => {
    expect(serviceProvider('https://county.example.gov/auth/', 'westwind')).toEqual({
      entityId: 'https://county.example.gov/auth/realms/westwind',
      redirectUri: 'https://county.example.gov/auth/realms/westwind/broker/county-sso/endpoint',
      metadataUrl:
        'https://county.example.gov/auth/realms/westwind/broker/county-sso/endpoint/descriptor',
    });
  });
});

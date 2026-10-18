/**
 * iOS readiness of the field app's Expo configuration (decision 2026-10-15:
 * built by Adam on his own Mac; FLD-02, DSP-08, FLD-15, FL-18, ADM-03).
 * The native project is generated from app.json, so what Xcode will see is
 * checked here, on every push, without a macOS runner.
 */
import { describe, expect, it } from 'vitest';
import appJson from '../app.json';

type Plugin = string | [string, Record<string, unknown>];
interface AppJson {
  expo: {
    platforms: string[];
    scheme: string;
    ios: {
      bundleIdentifier: string;
      buildNumber: string;
      infoPlist: Record<string, unknown>;
      privacyManifests: {
        NSPrivacyTracking: boolean;
        NSPrivacyAccessedAPITypes: { NSPrivacyAccessedAPIType: string }[];
      };
    };
    android: { package: string; versionCode: number };
    plugins: Plugin[];
  };
}

const app = appJson as unknown as AppJson;
const plugin = (name: string): Record<string, unknown> => {
  const p = app.expo.plugins.find((x) => Array.isArray(x) && x[0] === name) as
    [string, Record<string, unknown>] | undefined;
  if (!p) throw new Error(`plugin ${name} is not configured`);
  return p[1];
};
const text = (v: unknown): string => {
  expect(typeof v).toBe('string');
  expect((v as string).trim().length).toBeGreaterThan(20);
  return v as string;
};

describe('field app iOS configuration', () => {
  it('targets iOS with one reverse-DNS identifier shared with Android, a scheme and a build number', () => {
    expect(app.expo.platforms).toContain('ios');
    expect(app.expo.ios.bundleIdentifier).toMatch(/^[a-z][a-z0-9]*(\.[a-z][a-z0-9-]*){2,}$/);
    expect(app.expo.ios.bundleIdentifier).toBe(app.expo.android.package);
    expect(app.expo.ios.buildNumber).toMatch(/^[1-9]\d*$/);
    expect(app.expo.android.versionCode).toBeGreaterThanOrEqual(1);
    expect(app.expo.scheme).toMatch(/^[a-z][a-z0-9]+$/);
  });

  it('declares background location only while checked in, with every permission text written (DSP-08, FLD-15)', () => {
    expect(app.expo.ios.infoPlist['UIBackgroundModes']).toEqual(['location']);
    const loc = plugin('expo-location');
    text(loc['locationWhenInUsePermission']);
    text(loc['locationAlwaysAndWhenInUsePermission']);
    text(loc['locationAlwaysPermission']);
    text(app.expo.ios.infoPlist['NSLocationAlwaysUsageDescription']);
    for (const v of [
      loc['locationAlwaysAndWhenInUsePermission'],
      loc['locationAlwaysPermission'],
      app.expo.ios.infoPlist['NSLocationAlwaysUsageDescription'],
    ])
      expect(v as string).toMatch(/checked in/);
  });

  it('camera, photo, Face ID and microphone prompts say what each is for; nothing records in the background (FL-18)', () => {
    text(plugin('expo-camera')['cameraPermission']);
    expect(plugin('expo-camera')['microphonePermission']).toBe(false);
    text(plugin('expo-image-picker')['cameraPermission']);
    text(plugin('expo-image-picker')['photosPermission']);
    expect(plugin('expo-image-picker')['microphonePermission']).toBe(false);
    text(plugin('expo-local-authentication')['faceIDPermission']);
    const audio = plugin('expo-audio');
    expect(text(audio['microphonePermission'])).toMatch(/consent/);
    expect(audio['enableBackgroundRecording']).toBe(false);
  });

  it('carries a privacy manifest with no tracking and the required-reason APIs declared', () => {
    const pm = app.expo.ios.privacyManifests;
    expect(pm.NSPrivacyTracking).toBe(false);
    const kinds = pm.NSPrivacyAccessedAPITypes.map((x) => x.NSPrivacyAccessedAPIType);
    expect(kinds).toEqual(
      expect.arrayContaining([
        'NSPrivacyAccessedAPICategoryUserDefaults',
        'NSPrivacyAccessedAPICategoryFileTimestamp',
      ]),
    );
  });

  it('ships English and Spanish and keeps the product and county names out of the build (ADM-03)', () => {
    expect(app.expo.ios.infoPlist['CFBundleLocalizations']).toEqual(['en', 'es']);
    const extra = (app.expo as unknown as { extra: Record<string, string> }).extra;
    expect(extra['productName']).toBe('');
    expect(extra['countyName']).toBe('');
    // Permission texts name no product or county: one build serves every county.
    const texts = JSON.stringify(app.expo.plugins) + JSON.stringify(app.expo.ios.infoPlist);
    expect(texts).not.toMatch(/Westwind|Mennelabs/);
  });
});

import { describe, expect, it } from 'vitest';
import { screenshotsAllowed } from '../src/screens.ts';

describe('FLD-02: screenshots blocked on screens with personal details', () => {
  it('blocks every screen that can show a person, a home or a record', () => {
    for (const path of [
      '/home',
      '/work/0190cafe-0000-4000-8000-000000000001',
      '/find',
      '/record/survivor',
      '/people/0190cafe-0000-4000-8000-000000000002',
      '/shelter',
      '/checkpoint',
      '/document',
      '/scribe',
      '/map',
      '/sync',
      '/messages',
      '/need-help',
    ])
      expect(screenshotsAllowed(path), path).toBe(false);
  });

  it('allows only the screens that never show one', () => {
    for (const path of ['/sign-in', '/unlock', '/job-aids', '/settings', '/settings/'])
      expect(screenshotsAllowed(path), path).toBe(true);
  });

  it('a screen nobody listed is protected (default deny)', () => {
    expect(screenshotsAllowed('/some-new-screen')).toBe(false);
    expect(screenshotsAllowed('/')).toBe(false);
  });
});

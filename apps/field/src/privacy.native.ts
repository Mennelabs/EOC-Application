/**
 * Screenshot blocking on the phone (FLD-02): while a screen that can show a
 * person, a home or a record is open, screenshots and screen recording are
 * blocked (FLAG_SECURE on Android, which also blanks the app in the
 * recent-apps view; capture protection on iOS). The screens that never show
 * one are listed in @cg/field-core screens.ts.
 */
import * as ScreenCapture from 'expo-screen-capture';
import { useEffect } from 'react';

const KEY = 'personal-details';

export function useScreenshotGuard(allowed: boolean): void {
  useEffect(() => {
    if (allowed) return;
    void ScreenCapture.preventScreenCaptureAsync(KEY).catch(() => undefined);
    return () => {
      void ScreenCapture.allowScreenCaptureAsync(KEY).catch(() => undefined);
    };
  }, [allowed]);
}

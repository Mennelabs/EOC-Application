/**
 * Screenshot blocking (FLD-02) on the web build: a browser page cannot stop
 * a screenshot, so this does nothing there. The phone build blocks them
 * (privacy.native.ts).
 */
export function useScreenshotGuard(_allowed: boolean): void {}

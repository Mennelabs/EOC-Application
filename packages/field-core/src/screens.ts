/**
 * Which field screens may be captured (FLD-02: "screenshots blocked on
 * screens with personal details"). Default deny: every screen blocks
 * screenshots and screen recording, which also blanks the app in the phone's
 * recent-apps view, except the few that never show a person, a home or a
 * record. A new screen is protected until someone adds it here on purpose.
 */
export const SCREENSHOTS_ALLOWED: ReadonlySet<string> = new Set([
  '/sign-in',
  '/callback',
  '/unlock',
  '/job-aids',
  '/settings',
]);

export function screenshotsAllowed(path: string): boolean {
  return SCREENSHOTS_ALLOWED.has(path.replace(/\/+$/, '') || '/');
}

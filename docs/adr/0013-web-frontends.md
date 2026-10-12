# ADR-0013: React + Vite web apps, React Aria components, FormatJS for messages

- Status: proposed
- Date: 2026-10-12
- Requirements: CHN-02, PUB-07, INT-02..06, ACC-*, NFR-01, NFR-09, EQ-06/09

## Decision

Two web apps built with React 18 and Vite: `web-resident` (installable PWA, no account, under 300 KB first load) and `web-console`. Shared accessible components in `packages/ui` built on React Aria (Adobe), which implements WAI-ARIA patterns and has been tested with screen readers. Messages use ICU format through FormatJS (`react-intl`). The resident app's offline outbox uses IndexedDB with WebCrypto encryption. The console map uses MapLibre GL JS (ADR-0015).

## Alternatives considered

| Option                     | Why not                                                                                                   |
| -------------------------- | --------------------------------------------------------------------------------------------------------- |
| Next.js / server rendering | Adds a Node server to the resident path; static files on a CDN are cheaper and more available (SCL-05).   |
| Preact                     | Smaller, but React Aria and the React Native code share React; the budget is met with code splitting.     |
| Angular                    | Larger bundles; no sharing with React Native.                                                             |
| i18next                    | Fine choice; ICU plural/select handling is native in FormatJS and matches professional translation tools. |

## Why it fits SCL-11 and the government-cloud move

Static builds served by any web server or CDN; the API URL is injected at container start from an environment variable (no rebuild per environment).

## Consequences

The resident app has a performance budget enforced in CI (bundle size plus a Lighthouse run on throttled 3G).

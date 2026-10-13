# ADR-0028: Resident app as an installable web app with an encrypted device outbox and direct photo uploads

- Status: accepted
- Date: 2026-10-12
- Requirements: CHN-02, CHN-06, CHN-07, CHN-08, INT-02–INT-08, INT-11–INT-16, INT-19–INT-22, PHO-01–PHO-06, SCL-04, SCL-06, ACC-30, ACC-39, ACC-41, ACC-50, NFR-01

## Decision

The resident app (`apps/web-resident`) is a React single-page app served at the site root, installable through a web manifest and a small service worker that caches only the app shell (never answers or API responses). Deep links name the tenant and event (`/<tenant>/<event>`); the root forwards to the configured event. The question graph comes from the public API and is cached in clear on the device, with the shipped graph as the last resort, so the flow opens offline (SCL-06). The same engine the API and the channels use walks the graph; the app renders one node at a time.

Answers in progress and the outbox are kept in `localStorage` encrypted with AES-GCM under a key that lives in `sessionStorage`: closing the tab makes what remains unreadable, and "Clear my answers" removes both (ACC-41). Kiosk devices (`/<tenant>/<event>/kiosk`) keep the key on the device so unsent reports survive a restart and sync later (CHN-07). The outbox holds one report per execution id, retries with backoff and on reconnection, and shows "Not sent yet / Sending / Received / Failed" in words; a permanent refusal stops retrying and shows the reason (ACC-39, AC-11B).

Photos are prepared on the device: the picture's date and position are read as suggestions, the image is redrawn on a canvas so no metadata travels, compressed under the tenant's cap, checked once for darkness and blur with a plain retake suggestion, and uploaded straight to object storage with a presigned URL (SCL-04). Browsers reach object storage through the gateway's `objects.<host>` name, which the API presigns for (`S3_PUBLIC_ENDPOINT`), so the signature covers the host and path unchanged. Free text can be typed or dictated with the browser's speech recognition; "Help me fill in the answers" calls the extraction route and shows each candidate as "You said … is that right?" for one-tap confirmation; unconfirmed candidates are never saved; confirmed ones skip their questions and are marked on the review screen; the resident can switch computer help off (INT-12–14, AIG-10).

The optional after-saving questions are sent after the report is received (INT-19) and merged onto the report by the API or the worker; the confirmation shows the reference number in text and as a scannable code, offers to text it, and says what happens next without promising aid (INT-22, ACC-30, ACC-50).

## Alternatives considered

| Option                                               | Why not                                                                                                |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| IndexedDB with a full offline database               | Far more code for the same guarantees; one encrypted blob per report is enough for a short form.       |
| Uploading photos through the API                     | SCL-04 wants uploads straight to object storage so the API stays light under load; the API only signs. |
| A hosted form builder or survey widget               | The graph, its branching and the reading-level lint would live outside the repository and its tests.   |
| Native apps for residents                            | Fixed decision: residents use the no-install web app; installation is optional through the manifest.   |
| Pre-filling questions from extraction without asking | INT-13: unconfirmed extractions are never saved as answers; the resident confirms each one.            |

## Why it fits SCL-11 and the government-cloud move

The app is static files behind the gateway with runtime configuration from `/config.json`; the objects host and the API are the only origins it talks to, both named by configuration. Nothing in the build differs between Docker Desktop and the cloud.

## Consequences

The first load is about 150 kB compressed (React, the message formatter, the graph schema, the QR encoder); a lighter formatter is an option if slow connections need it. Photo uploads need the `objects.<host>` certificate trusted by the browser (the local CA locally; the platform ingress in the cloud). Resumable multipart uploads are not needed at the default 1.5 MB cap; the outbox retries a failed upload whole. HEIC pictures that a browser cannot decode are sent as they are and the worker marks them failed if it cannot read them.

- Direct uploads need the browser to reach a second host (`objects.<host>`) and trust its certificate. A browser that cannot (a development machine that only clicked through the warning for `localhost`, a network that blocks the host) sends the same bytes through the gateway to `PUT /api/public/intake/:tenant/photos/:id/content`, which stores them under the ticket's key; completion is the same call. The direct path stays the first choice (SCL-04); the fallback keeps photos from being lost (SCL-06), and the app says "offline" only when the device is.

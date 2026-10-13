# ADR-0031: Every public channel reads one published view: JSON, HSDS, GeoJSON, widget, media sheet, text and voice

- Status: accepted
- Date: 2026-10-13
- Requirements: PUB-01, PUB-03, PUB-05, PUB-06, PUB-10, PUB-13, PUB-16, PUB-17, PUB-18, NED-06, BRD:FR-16.02, AC-16A, AC-16B, SEC-09, SEC-10, SCL-06

## Decision

One module (`services/api/src/public/sites-view.ts`) decides what the public may see: sites that are published, not confidential, not merely planned, and inside their reconfirmation window (`coalesce(last_confirmed_at, published_at) + confirm_every_hours > now()`), nearest first when a place is given, each full or closed site naming the next nearest open one of its kind; and resources that are published, whose text for the language was reviewed by a person, and that have not expired. Every public output is a rendering of that view: the JSON the page reads, the Open Referral HSDS 3.0 document for 211 centers, the GeoJSON feed for news and mapping apps, the copy-and-paste widget, the media sheet, the resource pages, the SHELTER/REFUGIO text reply and the phone read-out. A change in the console reaches all of them on the next request; the public cache is one minute. Nothing goes out without a `cg.publication` row naming the approver, the reason, the snapshot and the channels; unpublishing and expiry are recorded on the same row, and the worker tells the PIO and the publishers once per publication and per withdrawal.

Public HTML is produced from plain data by pure functions (`render.ts`), every placed string escaped by the page shell, with a content-security policy that allows no scripts and no outside resources; resource bodies pass an allow-list sanitiser and an accessibility check (headings in order, links with text, images with alt text) before they can be published. An expired or withdrawn resource answers 410 with its date so nothing stale reads as current.

## Alternatives considered

| Option                                              | Why not                                                                                                       |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| A separate publishing step that writes static files | Two sources of truth and a window where channels disagree; PUB-01 wants one record behind every channel.      |
| Push to 211 and the feeds on each change            | Pull by the consumers at their pace is the HSDS norm; a push needs their endpoints and credentials.           |
| Rendering resource bodies from Markdown             | Staff already have HTML from their tools; the sanitiser and the check make it safe and accessible either way. |
| Hiding stale sites only on the web page             | PUB-03 says every channel; the view is the one place the rule lives.                                          |
| A timed refresh on the media sheet                  | Fails WCAG 2.2.1/3.2.5; the sheet says when it was generated and that a reload is the reader's choice.        |

## Why it fits SCL-11 and the government-cloud move

The feeds are ordinary routes on the API behind the gateway; the widget is a script that calls them. Caching is a response header any CDN in the government cloud honours. Nothing is written to storage for publication.

## Consequences

A consumer polling the feeds sees exactly what residents see. Confidential sites cannot leak through a channel added later, because there is no second query to forget them in. The one-minute cache bounds how quickly a change is seen by a consumer that caches (the measured path in the stack suite is seconds). Adding a channel means adding a renderer, not a rule.

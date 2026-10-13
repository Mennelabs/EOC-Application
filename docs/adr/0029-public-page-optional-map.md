# ADR-0029: The public "Find help" page is a list first; the map is optional, loaded on request, and reads self-hosted PMTiles

- Status: accepted
- Date: 2026-10-13
- Requirements: PUB-07, PUB-02, PUB-04, PUB-15, SCL-13, SCL-06, ACC-07, A11Y-01, EQ-06, RULE-12, NFR-06

## Decision

The public page (`apps/web-help`) is a small page without a framework: plain TypeScript, one stylesheet, one request to the public help endpoint, under 50 KB on first load against the 300 KB budget that CI and the web image build enforce (`scripts/check-size.mjs`). It lists open sites nearest first, with everything PUB-02 names, and shows a map only when the visitor asks for it. The map module (MapLibre GL and the PMTiles protocol, about a megabyte) is a separate chunk imported on that click, so a visitor on a slow connection or a screen reader never pays for it. The map reads the county's vector tiles straight from `/tiles/region.pmtiles` over HTTP range requests, with a label-free style so no glyph server is needed; markers are buttons that move focus to the site's card in the list, and the list stays on the page whatever the map does. Without tiles the markers still work on a plain background.

"Nearest" needs no geocoder: the API resolves a five-digit ZIP from `cg.zip_centroid` (seeded per tenant), a `lat,lon` pair from the browser's location, and anything else through the self-hosted geocoder when the maps profile is on; a place it cannot resolve is said plainly and everything is listed. The same resolution serves the text and voice channels (PUB-08, PUB-09). The page is served by the web container at `/<county>/help`, caches nothing personal, keeps what the visitor typed in the address bar only, and shows the last list with a notice when the API cannot be reached (SCL-06). The poster view (PUB-15) renders the phone number, the short address and a QR code generated in the browser from that address, never the QR code alone.

## Alternatives considered

| Option                                      | Why not                                                                                                             |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Reuse the resident app (React) for the page | Its first load is several times the budget; the page needs no state, forms beyond one search, or an outbox.         |
| Map first, list second                      | A map is not operable by keyboard or screen reader in the way a list is (ACC-07, check 13); the list is the record. |
| Raster tiles from a public provider         | A third-party request on every view (privacy) and an outside dependency during a disaster (SCL-13: self-hosted).    |
| Geocoding every search through Nominatim    | ZIP centroids answer the common case without the maps profile; the geocoder is an opt-in improvement.               |
| A labelled map style with a glyph server    | One more container for labels the list already carries; the map is a picture of where, not a replacement.           |

## Why it fits SCL-11 and the government-cloud move

The page is static files in the web image; the tiles are a file on a volume served with range requests by the gateway; both move unchanged. Nothing in the page talks to any host but its own origin.

## Consequences

The public page carries no analytics and no cookies. Site names, services and addresses come from the API's one public view (ADR-0031), so the page cannot show what the console has not published. The map's size is paid only by visitors who ask for it; the label-free style means street names come from the list, not the map, which the design accepts for now (a glyph server is a later addition if the PIO wants labels).

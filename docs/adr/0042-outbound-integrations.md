# ADR-0042: Outbound integrations: per-tenant API keys, Standard Webhooks, a GeoServices query subset

- Status: accepted
- Date: 2026-10-15
- Requirements: SCL-09, ADM-05 (G6), GATE-04, SEC-18, CON-17, SCL-11, SEC-15; CLAUDE.md rule 9 (secrets never in logs)

## Decision

**API keys.** A key is `cgk_<12-character prefix>_<32 random bytes, base64url>`. Only the SHA-256 of the whole key is stored (256 random bits need no salt or slow hash); the prefix finds the row, the hash is compared in constant time. The key is shown once, to the administrator who asked for it. It works only after a second administrator approves it (guardrail G6: never the one who asked; frozen during break-glass), always expires (a year at most), carries scopes (release 1: `pda.read`) and can be revoked by either administrator. Its version moves only with administrative changes, so recording its last use never makes a revoke stale. Every bad key (unknown, malformed, pending, revoked, expired, wrong scope) gets the same 401. A key may arrive as `X-API-Key` or as the `token` parameter GIS clients send; the request serializer removes `token=` from logged URLs and the header is redacted.

**Webhooks.** An administrator names an HTTPS receiver and the events it hears (`official_report.issued`, `export.ready`); a second administrator approves it before anything is sent. Deliveries are signed per the [Standard Webhooks](https://www.standardwebhooks.com/) scheme (`webhook-id`, `webhook-timestamp`, `webhook-signature: v1,<base64 HMAC-SHA256 of id.timestamp.body>`, secret `whsec_…` shown once and kept encrypted under the tenant key, SEC-10), so receivers can verify them with any Standard Webhooks library. A delivery is queued in the transaction that made the event true (one per webhook, event and record, so a retried job never queues twice), claimed under a two-minute lease with `FOR UPDATE SKIP LOCKED`, sent once, and retried at 1 min, 5 min, 30 min, 2 h, then every 6 h, failed after eight attempts. Payloads name records (ids, titles, sizes, hashes), never people.

**Where a webhook may go (OWASP SSRF).** HTTPS only; a host name, never an address literal; no user or password; port 443 or 8443; not `localhost`, `.local`, `.internal` or a single-label name. When sending, every address the name resolves to must be public (private, loopback, link-local, carrier-grade NAT, documentation, multicast and reserved ranges refused, IPv4-mapped IPv6 judged as its IPv4), the connection goes to the address that was checked (no second lookup to rebind), TLS still verifies the host name, redirects are not followed, ten seconds at most.

**The feature service.** `GET /api/gis/:tenant/pda/FeatureServer[/0[/query]]` answers the part of the GeoServices REST specification a GIS client needs to add a layer by URL: service and layer descriptions, and `query` with `where` (`1=1`, or `Field = 'value'` and numbers joined by `AND`, on the layer's own fields), `outFields`, `objectIds`, `returnGeometry`, `resultOffset`/`resultRecordCount` (2,000 at most), `returnCountOnly`, `returnIdsOnly`, `f=json` (Esri JSON) or `f=geojson`, WGS 84. The `where` clause is parsed by a small grammar and applied in memory to the computed layer; it never reaches SQL. Anything else (spatial filters, other spatial references, `orderByFields`) is refused with a message rather than ignored, so a partial answer is never read as complete. The layer is the IDA package's PDA layer (the mapping in force, the 100 m cell, nothing personal); one event per service, the most recently opened active one or `?event=`. Each answer is audited against the key.

## Alternatives

- **OAuth client credentials through Keycloak for machine clients.** Standard, but GIS desktop clients add feature services with a static token far more easily than with an OAuth flow, and every county would need a client registration per integration. Keys can move to OAuth later behind the same scopes.
- **Our own webhook signature.** Rejected: Standard Webhooks is documented, has libraries in every language, and gives receivers replay protection through the timestamp.
- **Following redirects and resolving at send time only.** Rejected: a redirect or a DNS rebinding is how an outbound webhook reaches a metadata service or the stack's own network.
- **A full ArcGIS Server or GeoServer in a container.** Rejected for release 1: a large new runtime with its own CVE stream (SEC-15) to serve one read-only layer; the subset above is enough for ArcGIS Pro, ArcGIS Online and QGIS to add the layer. Esri tools also keep the GeoJSON and CSV in the IDA package (CON-17).
- **Translating `where` into SQL.** Rejected: an injection surface for a layer of a few thousand homes that is cheaper to filter in memory.

## Consequences

- No new runtime dependency: `node:crypto`, `node:dns`, `node:net` (`BlockList`) and `node:https`.
- A webhook to a test receiver on a laptop needs a public HTTPS name (a secured development tunnel, CLAUDE.md rule 3); private addresses are refused by design.
- The feature service caches a computed layer for 30 seconds per event; a layer is at most that stale.
- Webhook payloads and keys appear in no log; the audit chain records who asked, who approved, each key's use and each final delivery outcome.

## Amendment 2026-10-15

- **The connection really goes to the checked address.** Node asks a custom lookup for every address when it connects; the first sender answered with one and every delivery failed to connect. `pinnedLookup` answers both forms, and a test now delivers through the real sender over TLS to a local receiver.
- **Outside-link checks follow the same rule.** The daily check of a public resource's outside link (PUB-18, MET-07) fetched whatever staff typed, redirects included. It now uses `publicLinkCheck`: http or https on ports 80, 443, 8080 or 8443, public addresses only, connected to the checked address, at most three redirects each checked the same way, five seconds a request, and only "answers" or "does not" is kept. The checks run with no transaction open.

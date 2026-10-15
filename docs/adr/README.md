# Architecture decision records

One record per technology choice (SCL-15). Use `0000-template.md` for new ones. All are **proposed** until Adam approves the first deliverables.

| ADR                                               | Decision                                                                                                      |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| [0001](0001-record-decisions.md)                  | Record technology decisions as ADRs                                                                           |
| [0002](0002-typescript-node.md)                   | TypeScript on Node.js 22 LTS for every service and app                                                        |
| [0003](0003-monorepo-pnpm.md)                     | pnpm workspaces monorepo                                                                                      |
| [0004](0004-api-fastify-zod.md)                   | Fastify + zod for the HTTP API, OpenAPI generated from schemas                                                |
| [0005](0005-postgres-postgis-kysely.md)           | PostgreSQL 16 + PostGIS, Kysely query builder, SQL migrations                                                 |
| [0006](0006-tenant-isolation-rls.md)              | Tenant isolation with Postgres row-level security plus per-tenant storage keys                                |
| [0007](0007-queue-rabbitmq.md)                    | RabbitMQ (AMQP 0-9-1, quorum queues) with a transactional outbox                                              |
| [0008](0008-identity-keycloak.md)                 | Keycloak for staff identity, SSO brokering and passkey MFA                                                    |
| [0009](0009-keys-openbao.md)                      | Envelope encryption with per-tenant keys; OpenBao locally, cloud KMS in production                            |
| [0010](0010-object-storage.md)                    | S3 API for object storage; MinIO locally; presigned multipart uploads                                         |
| [0011](0011-authorization-engine.md)              | In-house policy engine with coded guardrails, Postgres RLS as backstop                                        |
| [0012](0012-audit-log.md)                         | Append-only, hash-chained audit log in Postgres with object-locked anchors                                    |
| [0013](0013-web-frontends.md)                     | React + Vite web apps, React Aria components, FormatJS for messages                                           |
| [0014](0014-field-app-react-native.md)            | Field app on React Native with Expo (local builds), MapLibre RN, SQLCipher                                    |
| [0015](0015-maps-tiles-geocoding.md)              | MapLibre + self-hosted OpenStreetMap PMTiles, Nominatim geocoding, USNG                                       |
| [0016](0016-sms-voice-twilio.md)                  | Twilio behind a `comms` adapter, with a local simulator                                                       |
| [0017](0017-ai-provider-interface.md)             | Pluggable AI interfaces with a deterministic fake provider                                                    |
| [0018](0018-testing.md)                           | Vitest, Playwright + axe-core, Testcontainers/Compose, k6                                                     |
| [0019](0019-ci-supply-chain.md)                   | GitHub Actions CI with Semgrep, Trivy, Syft SBOM and cosign signing                                           |
| [0020](0020-gateway-caddy.md)                     | Caddy as the local gateway (TLS, routing, security headers, static tiles)                                     |
| [0021](0021-cjis-enclave-isolation.md)            | CJIS enclave as a separate Compose project with its own network, data, keys and identity                      |
| [0022](0022-realtime-sse.md)                      | Server-Sent Events for live console updates                                                                   |
| [0023](0023-observability.md)                     | Structured logs with pino (classification-aware redaction), OpenTelemetry later                               |
| [0024](0024-question-graph-engine.md)             | Intake as a versioned question graph with one deterministic engine for every channel                          |
| [0025](0025-ai-interfaces-fake-provider.md)       | Pluggable AI behind four interfaces, a deterministic fake provider, an evaluation gate                        |
| [0026](0026-filing-submissions.md)                | Filing submissions with one idempotent function behind a queue consumer and a sweep                           |
| [0027](0027-comms-adapter-sessions.md)            | Text and voice on the same graph through a signed-webhook adapter with a local simulator                      |
| [0028](0028-resident-app.md)                      | Resident app as an installable web app with an encrypted device outbox                                        |
| [0029](0029-public-page-optional-map.md)          | Public "Find help" is a list first; the map is optional and reads self-hosted PMTiles                         |
| [0030](0030-sharing-by-grants.md)                 | Partners read residents' records only through share grants with a minimum-field projection                    |
| [0031](0031-one-public-view-many-channels.md)     | Every public channel reads one published view (JSON, HSDS, GeoJSON, widget, media, text, voice)               |
| [0032](0032-field-sync-and-storage.md)            | The field app writes to an encrypted outbox and syncs by commands and a change feed                           |
| [0033](0033-positions-and-location-privacy.md)    | Positions only while checked in, seen only by dispatch and safety roles, kept 30 days                         |
| [0034](0034-live-stream-fan-out.md)               | The live stream reads the change feed; RabbitMQ only wakes it                                                 |
| [0035](0035-field-app-web-build-for-tests.md)     | The field app's web build runs the same screens for browser and accessibility tests                           |
| [0036](0036-enclave-identity-and-cjis-values.md)  | Enclave identity: its own realm, a second factor proven in the token, and the CJIS values                     |
| [0037](0037-enclave-data-keys-audit-retention.md) | Enclave data, per-agency keys, its own audit chain, retention and worker                                      |
| [0038](0038-enclave-app-on-its-own-origin.md)     | The enclave's screens are its own web app on its own address; the console only links                          |
| [0039](0039-reference-data-sources.md)            | Reference data from free public services, with file import for every dataset                                  |
| [0040](0040-pdf-engine.md)                        | PDFs drawn by PDFKit as PDF/UA-1 with Noto Sans embedded, checked by veraPDF in CI                            |
| [0041](0041-reference-import-formats.md)          | Reference files read with what Node ships: CSV, GeoJSON, GeoPackage, zipped Shapefile; WGS 84 only            |
| [0042](0042-outbound-integrations.md)             | Per-tenant API keys, Standard Webhooks with SSRF limits, and a GeoServices query subset for the PDA layer     |
| [0043](0043-openai-for-every-ai-function.md)      | OpenAI behind the AI interfaces for every function; a damage classifier interface; no fake in running systems |
| [0044](0044-command-window-execution.md)          | The command window runs catalogued actions through the console's own operations, bound to a confirmed plan    |
| [0045](0045-design-system.md)                     | One design foundation for every web app: tokens, self-hosted fonts, React Aria components                     |

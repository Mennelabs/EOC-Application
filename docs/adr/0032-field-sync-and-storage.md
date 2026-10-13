# ADR-0032: The field app writes to an encrypted outbox and syncs by commands and a change feed

- Status: accepted
- Date: 2026-10-13
- Requirements: FLD-01, FLD-02, FLD-13, FLD-14, AC-00B, AC-00C, NFR-08, SCL-06, SEC-05, ADR-0014, ADR-0022

## Decision

Everything a responder does in the field app is saved on the phone first, as a command in an encrypted outbox, and shown as "On this phone" until the server has it ("Received"). The phone sends commands in batches to `POST /field/commands`; each command has the phone's own id, and the server records each id once in `cg.client_command` with its outcome. A resend of the same id answers with the stored outcome and applies nothing again (AC-00C). A command built on an old version of a record is not applied: the answer is `conflict` with the current record, and the phone keeps the responder's entry until they decide (AC-00B). Each command is replayed inside the request against the ordinary console route (`instance.inject`) with the responder's own token, so the same permission checks, field protection and audit apply whether a change comes from the console or the field. Records keyed by the phone (assessments, help alerts, service logs, the role records `record.<kind>`) take the command id as their `clientUuid`, so the record and the command agree.

The phone reads what changed with `GET /field/sync?cursor=`, a page of `cg.change_feed` rows (ADR-0022) limited to the responder's own team, assignments and area, and `GET /field/area` for the work area's parcels and map extract. Resident details are removed from the phone once the server has them and at check-out (FLD-14); a remote wipe clears only the app's data on its next contact (FLD-02).

Storage sits behind one interface (`FieldStore` in `packages/field-core`). On phones it is SQLite with SQLCipher (`expo-sqlite`), the database key random and held in the Keychain or Keystore, released after the PIN or the phone's biometric check. On the web build it is IndexedDB with every record AES-GCM encrypted under a key derived from the PIN (PBKDF2-SHA-256, 310,000 iterations). Ten wrong PINs clear the app's data. The plan named op-sqlite; `expo-sqlite` gained SQLCipher support in this SDK and needs no extra native module, so it was used instead.

## Alternatives considered

| Option                                  | Why not                                                                                                               |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| A replicated database (CouchDB/PouchDB) | A second data store beside PostgreSQL with its own access rules; row security and the audit would have to be rebuilt. |
| Field-only API routes                   | Two copies of every rule; the replay through the console routes keeps one.                                            |
| Last write wins                         | Loses a responder's work silently; FLD-13 wants both entries kept and a person to decide.                             |
| Plain (unencrypted) phone storage       | A lost phone would give up resident details (NFR-08).                                                                 |
| op-sqlite with SQLCipher                | Works, but adds a native module; `expo-sqlite` does the same job inside the SDK the app already uses.                 |

## Why it fits SCL-11 and the government-cloud move

The sync is ordinary HTTPS to the same API behind the gateway; nothing needs a separate sync server. The change feed is a PostgreSQL table read under row security. Phones hold no server secret; the only keys on the phone are the app's own storage key and the responder's tokens.

## Consequences

A phone can work a whole shift without signal and lose nothing. The server never applies a stale change, and the responder sees why. Every field change carries the same audit trail as a console change. The outbox can grow while offline; the home screen shows the count, and the check-out keeps unsent records until they are received.

# ADR-0009: Envelope encryption with per-tenant keys; OpenBao locally, cloud KMS in production

- Status: proposed
- Date: 2026-10-12
- Requirements: SEC-10, SEC-11, SCL-11, SEC-12

## Decision

Restricted columns are encrypted in the application with AES-256-GCM data keys. Each data key is wrapped by a per-tenant key-encryption key held by the `keys` adapter. Locally that is OpenBao's transit engine (open-source Vault fork); in the cloud it is AWS KMS or Azure Key Vault. Wrapped keys are cached in memory for a short time; plaintext keys never touch disk or logs. The enclave has its own OpenBao/KMS.

## Alternatives considered

| Option                   | Why not                                                                                 |
| ------------------------ | --------------------------------------------------------------------------------------- |
| HashiCorp Vault          | Business Source License since 2023; OpenBao is the MPL-licensed fork with the same API. |
| pgcrypto in the database | Keys would sit next to the data; a DB dump would expose both.                           |
| Encryption at rest only  | Does not satisfy SEC-10's field-level requirement.                                      |

## Why it fits SCL-11 and the government-cloud move

The adapter interface (`wrapKey`, `unwrapKey`, `rotate`) maps one-to-one onto KMS `Encrypt`/`Decrypt`/`GenerateDataKey`. Local dev uses OpenBao with a file backend and a dev-only auto-unseal key stored in a Docker volume (never used outside a laptop).

## Consequences

Searching encrypted fields needs blind indexes (HMAC of the normalized value) for exact-match lookups such as phone number (FL-02). Key rotation re-wraps data keys without re-encrypting data.

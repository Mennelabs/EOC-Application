# ADR-0010: S3 API for object storage; MinIO locally; presigned multipart uploads

- Status: proposed
- Date: 2026-10-12
- Requirements: SCL-04, SCL-11, PHO-05/06/07, SEC-05

## Decision

All binary data (photos, documents, exports, official-report snapshots, audit anchors) goes through the `storage` adapter, which speaks the S3 API via `@aws-sdk/client-s3`. Locally: MinIO (fixed decision in CLAUDE.md). Uploads go straight from the client to storage with presigned multipart URLs (resumable, SCL-04). Keys follow `tenant/<tenant_id>/<kind>/<uuid>`; originals and derivatives are separate objects, and EXIF-stripped, blurred derivatives are what non-reviewers see (PHO-06/07).

## Alternatives considered

| Option                     | Why not                                               |
| -------------------------- | ----------------------------------------------------- |
| Storing files in Postgres  | Bloats backups; no direct client upload.              |
| tus protocol server        | Another service to run; S3 multipart already resumes. |
| SeaweedFS / Garage locally | Also S3-compatible, but CLAUDE.md names MinIO.        |

## Why it fits SCL-11 and the government-cloud move

S3 in GovCloud (and S3-compatible stores elsewhere) need only endpoint and credential changes. Object lock is used for audit anchors and issued report snapshots.

## Consequences

MinIO stopped publishing community container images in 2025. We build MinIO from its pinned source release in `infra/minio/Dockerfile`, so it can be scanned and patched like our own images. That is a local stand-in only; production uses the cloud's S3.

## Object lock, as built (layer 6, 2026-10-14)

- A second bucket, `S3_RECORDS_BUCKET` (`<S3_BUCKET>-records` by default), holds what must never change: issued official reports and audit anchors. The worker creates it with object lock on and refuses to write records to a bucket that lacks it (object lock cannot be added to an existing bucket).
- Each object is written with `ObjectLockMode` from `S3_LOCK_MODE` (COMPLIANCE by default: nobody can shorten or lift the lock, not even the storage account's root) and a retain-until date: an issued report's issue time plus the tenant's `records` retention (SEC-13, 7 years by default); an audit anchor seven years.
- The database snapshot is the primary frozen copy (append-only, refused to every role by trigger); the locked object is the second. The API never waits on storage to issue a report: the worker writes the copy from the outbox, checks the snapshot still hashes to what was issued first, and records the object key, version and lock in `official_report_lock`.
- Checked against the local MinIO build: a locked write keeps its retention, deleting that version is refused, and a bucket made without object lock is refused. In AWS GovCloud the same calls apply unchanged.

/**
 * Storage adapter (ADR-0010). S3 API so MinIO locally and S3 in the cloud
 * differ only by configuration (SCL-11). Records that must never change
 * (issued official reports, audit anchors) go to a second bucket created with
 * object lock, each object locked until its retention ends (RULE-10, SEC-13).
 */
import {
  CreateBucketCommand,
  GetObjectLockConfigurationCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { Probe } from './health.ts';

export interface StorageSettings {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

export function createS3(s: StorageSettings): S3Client {
  return new S3Client({
    endpoint: s.endpoint,
    region: s.region,
    forcePathStyle: true,
    credentials: { accessKeyId: s.accessKeyId, secretAccessKey: s.secretAccessKey },
  });
}

export async function ensureBucket(client: S3Client, bucket: string): Promise<void> {
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch {
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
  }
}

export type LockMode = 'GOVERNANCE' | 'COMPLIANCE';

/**
 * The records bucket, created with object lock on. Object lock cannot be added
 * to a bucket made without it, so a bucket that lacks it is refused rather
 * than used as if it were locked.
 */
export async function ensureLockedBucket(client: S3Client, bucket: string): Promise<void> {
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch {
    await client.send(
      new CreateBucketCommand({ Bucket: bucket, ObjectLockEnabledForBucket: true }),
    );
  }
  const conf = await client.send(new GetObjectLockConfigurationCommand({ Bucket: bucket }));
  if (conf.ObjectLockConfiguration?.ObjectLockEnabled !== 'Enabled')
    throw new Error(`bucket ${bucket} has no object lock; records are not written there`);
}

/** Writes an object that nobody can change or delete before `retainUntil` (in COMPLIANCE mode, not even an administrator). */
export async function putLocked(
  client: S3Client,
  bucket: string,
  input: {
    key: string;
    body: string | Buffer;
    contentType: string;
    mode: LockMode;
    retainUntil: Date;
  },
): Promise<{ versionId: string | null }> {
  const res = await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: input.key,
      Body: input.body,
      ContentType: input.contentType,
      ObjectLockMode: input.mode,
      ObjectLockRetainUntilDate: input.retainUntil,
      // Object lock writes must carry an integrity checksum.
      ChecksumAlgorithm: 'SHA256',
    }),
  );
  return { versionId: res.VersionId ?? null };
}

export function storageProbe(name: string, client: S3Client, bucket: string): Probe {
  return {
    name,
    async check(signal) {
      await client.send(new HeadBucketCommand({ Bucket: bucket }), { abortSignal: signal });
    },
  };
}

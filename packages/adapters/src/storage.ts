/**
 * Storage adapter (ADR-0010). S3 API so MinIO locally and S3 in the cloud
 * differ only by configuration (SCL-11).
 */
import { CreateBucketCommand, HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';
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

export function storageProbe(name: string, client: S3Client, bucket: string): Probe {
  return {
    name,
    async check(signal) {
      await client.send(new HeadBucketCommand({ Bucket: bucket }), { abortSignal: signal });
    },
  };
}

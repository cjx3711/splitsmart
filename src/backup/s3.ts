/**
 * Transport primitives for the S3-compatible target (Tigris).
 *
 * Key naming and retention policy live in `retention.ts`, next to the
 * invariant they depend on. This module stays a dumb pipe.
 */

import { createReadStream } from "node:fs";
import { Transform } from "node:stream";
import { createGzip } from "node:zlib";
import {
  CopyObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import type { BackupSettings } from "./config.ts";

/** S3 caps a single DeleteObjects request at 1000 keys. */
const DELETE_BATCH_SIZE = 1000;
const GZIP_LEVEL = 6;

export function createS3Client(settings: BackupSettings): S3Client {
  return new S3Client({
    region: settings.region,
    endpoint: settings.endpoint,
    forcePathStyle: settings.forcePathStyle,
    // Passed explicitly: the SDK's default credential chain would otherwise
    // pick up a half-set AWS_* pair and fail at request time instead of at
    // config-parse time.
    credentials: {
      accessKeyId: settings.accessKeyId,
      secretAccessKey: settings.secretAccessKey,
    },
    // SDK 3.11xx defaults to `when_supported`, which attaches CRC32 trailers
    // that have historically broken S3-compatible providers.
    requestChecksumCalculation:
      settings.checksumMode === "when_required" ? "WHEN_REQUIRED" : "WHEN_SUPPORTED",
    // Deliberately NO `logger`: the SDK logger prints signed request headers.
  });
}

export type UploadResult = { compressedBytes: number };

/**
 * Stream `filePath` through gzip straight into the bucket. NEVER buffer.
 *
 * `lib-storage`'s `Upload` takes a stream and switches to multipart with
 * roughly 20 MB of buffering (4 concurrent 5 MB parts).
 *
 * `compressed_bytes` comes off the counting Transform: exact, and with no
 * extra `HeadObject` round-trip.
 */
export async function uploadGzipStream(options: {
  client: S3Client;
  settings: BackupSettings;
  key: string;
  filePath: string;
  abortSignal?: AbortSignal;
}): Promise<UploadResult> {
  const { client, settings, key, filePath, abortSignal } = options;

  let compressedBytes = 0;
  const counter = new Transform({
    transform(chunk, _encoding, callback) {
      compressedBytes += chunk.length;
      callback(null, chunk);
    },
  });

  const source = createReadStream(filePath);
  const gzip = createGzip({ level: GZIP_LEVEL });
  const body = source.pipe(gzip).pipe(counter);

  const upload = new Upload({
    client,
    params: {
      Bucket: settings.bucket,
      Key: key,
      Body: body,
      ContentType: "application/gzip",
    },
  });

  const onAbort = () => {
    void upload.abort();
  };
  abortSignal?.addEventListener("abort", onAbort, { once: true });

  try {
    if (abortSignal?.aborted) {
      throw new Error("Upload aborted before it started");
    }
    await upload.done();
    return { compressedBytes };
  } finally {
    abortSignal?.removeEventListener("abort", onAbort);
    source.destroy();
    gzip.destroy();
    counter.destroy();
  }
}

/** Server-side copy — no second gzip pass, no second upload. */
export async function copyObject(
  client: S3Client,
  settings: BackupSettings,
  sourceKey: string,
  destinationKey: string,
): Promise<void> {
  await client.send(
    new CopyObjectCommand({
      Bucket: settings.bucket,
      CopySource: `${settings.bucket}/${sourceKey}`
        .split("/")
        .map(encodeURIComponent)
        .join("/"),
      Key: destinationKey,
      ContentType: "application/gzip",
    }),
  );
}

export type ObjectSummary = { key: string; size: number };

/** Every object under `prefix`, following continuation tokens to the end. */
export async function listObjectSummaries(
  client: S3Client,
  settings: BackupSettings,
  prefix: string,
): Promise<ObjectSummary[]> {
  const objects: ObjectSummary[] = [];
  let continuationToken: string | undefined;

  do {
    const response = await client.send(
      new ListObjectsV2Command({
        Bucket: settings.bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    );
    for (const object of response.Contents ?? []) {
      if (object.Key) {
        objects.push({ key: object.Key, size: object.Size ?? 0 });
      }
    }
    continuationToken = response.IsTruncated
      ? response.NextContinuationToken
      : undefined;
  } while (continuationToken);

  return objects;
}

/** Every key under `prefix`, following continuation tokens to the end. */
export async function listObjectKeys(
  client: S3Client,
  settings: BackupSettings,
  prefix: string,
): Promise<string[]> {
  const objects = await listObjectSummaries(client, settings, prefix);
  return objects.map((object) => object.key);
}

/** Returns the number of keys the service confirmed deleted. */
export async function deleteObjects(
  client: S3Client,
  settings: BackupSettings,
  keys: string[],
): Promise<number> {
  let deleted = 0;

  for (let index = 0; index < keys.length; index += DELETE_BATCH_SIZE) {
    const batch = keys.slice(index, index + DELETE_BATCH_SIZE);
    const response = await client.send(
      new DeleteObjectsCommand({
        Bucket: settings.bucket,
        Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
      }),
    );
    for (const error of response.Errors ?? []) {
      console.error(
        `[backup] failed to delete ${error.Key}: ${error.Code} ${error.Message}`,
      );
    }
    deleted += batch.length - (response.Errors?.length ?? 0);
  }

  return deleted;
}

import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, unlink } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { serverConfig } from "../config.js";
import type { MediaAssetKind, MediaStorageDriver, StoredMediaAsset } from "../types.js";

let objectStorageClient: S3Client | null = null;

export type ObjectStorageHealth = {
  status: "ok" | "error" | "skipped";
  storageDriver: MediaStorageDriver;
  bucket: string | null;
  endpoint: string | null;
  message: string | null;
  checkedAt: string;
};

function getConfiguredStorageDriver(): MediaStorageDriver {
  const value = (process.env.MEDIA_STORAGE_DRIVER ?? "local").toLowerCase();

  if (value === "local" || value === "r2") {
    return value;
  }

  throw new Error(`Unsupported MEDIA_STORAGE_DRIVER "${value}".`);
}

function getRequiredR2Config() {
  const accountId = process.env.R2_ACCOUNT_ID;
  const bucket = process.env.R2_BUCKET_NAME;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;

  if (!accountId || !bucket || !accessKeyId || !secretAccessKey) {
    throw new Error(
      "R2 storage is enabled, but one or more required variables are missing: R2_ACCOUNT_ID, R2_BUCKET_NAME, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY.",
    );
  }

  return {
    accountId,
    bucket,
    accessKeyId,
    secretAccessKey,
    region: process.env.R2_REGION ?? serverConfig.r2.defaultRegion,
  };
}

function getObjectStorageClient() {
  if (objectStorageClient) {
    return objectStorageClient;
  }

  const config = getRequiredR2Config();

  objectStorageClient = new S3Client({
    region: config.region,
    endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });

  return objectStorageClient;
}

function getObjectStorageEndpoint() {
  if (!isR2StorageEnabled()) {
    return null;
  }

  const config = getRequiredR2Config();
  return `https://${config.accountId}.r2.cloudflarestorage.com`;
}

function toStorageErrorMessage(error: unknown) {
  if (error instanceof Error) {
    const statusCode = "statusCode" in error ? String(error.statusCode) : null;
    const errorCode = "Code" in error ? String(error.Code) : null;
    const pieces = [error.name, errorCode, statusCode].filter(Boolean);

    return pieces.length > 0
      ? `${error.message} (${pieces.join("/")})`
      : error.message;
  }

  return "Unknown object storage error.";
}

export function getMediaStorageDriver() {
  return getConfiguredStorageDriver();
}

export function isR2StorageEnabled() {
  return getConfiguredStorageDriver() === "r2";
}

export function assertObjectStorageReady() {
  if (!isR2StorageEnabled()) {
    return;
  }

  getRequiredR2Config();
}

export async function checkObjectStorageHealth(): Promise<ObjectStorageHealth> {
  const checkedAt = new Date().toISOString();
  const storageDriver = getMediaStorageDriver();

  if (storageDriver === "local") {
    return {
      status: "skipped",
      storageDriver,
      bucket: null,
      endpoint: null,
      message: "Object storage health check skipped because MEDIA_STORAGE_DRIVER=local.",
      checkedAt,
    };
  }

  const client = getObjectStorageClient();
  const config = getRequiredR2Config();
  const key = `healthchecks/${randomUUID()}.txt`;

  try {
    await client.send(
      new PutObjectCommand({
        Bucket: config.bucket,
        Key: key,
        Body: `object storage health check ${checkedAt}`,
        ContentType: "text/plain; charset=utf-8",
      }),
    );

    await client.send(
      new DeleteObjectCommand({
        Bucket: config.bucket,
        Key: key,
      }),
    );

    return {
      status: "ok",
      storageDriver,
      bucket: config.bucket,
      endpoint: getObjectStorageEndpoint(),
      message: null,
      checkedAt,
    };
  } catch (error) {
    return {
      status: "error",
      storageDriver,
      bucket: config.bucket,
      endpoint: getObjectStorageEndpoint(),
      message: toStorageErrorMessage(error),
      checkedAt,
    };
  }
}

export function buildObjectStorageKey(kind: MediaAssetKind, storedName: string) {
  return `${kind === "upload" ? "uploads" : "outputs"}/${storedName}`;
}

export function buildThumbnailStorageKey(storedName: string) {
  const extensionlessName = path.basename(storedName, path.extname(storedName));
  return `thumbnails/${extensionlessName}.jpg`;
}

export function buildTemporaryWorkingFilePath(prefix: string, storedName: string) {
  return path.join(serverConfig.tempDir, prefix, `${randomUUID()}-${storedName}`);
}

export async function ensureWorkingDirectory(filePath: string) {
  await mkdir(path.dirname(filePath), { recursive: true });
}

export async function uploadLocalFileToR2(input: {
  localFilePath: string;
  objectKey: string;
  contentType: string;
}) {
  const client = getObjectStorageClient();
  const config = getRequiredR2Config();

  await client.send(
    new PutObjectCommand({
      Bucket: config.bucket,
      Key: input.objectKey,
      Body: createReadStream(input.localFilePath),
      ContentType: input.contentType,
    }),
  );
}

export async function deleteR2Object(objectKey: string) {
  const client = getObjectStorageClient();
  const config = getRequiredR2Config();

  await client.send(
    new DeleteObjectCommand({
      Bucket: config.bucket,
      Key: objectKey,
    }),
  );
}

export async function downloadR2ObjectToLocalFile(input: {
  objectKey: string;
  localFilePath: string;
}) {
  const client = getObjectStorageClient();
  const config = getRequiredR2Config();

  await ensureWorkingDirectory(input.localFilePath);

  const response = await client.send(
    new GetObjectCommand({
      Bucket: config.bucket,
      Key: input.objectKey,
    }),
  );

  if (!response.Body) {
    throw new Error(`R2 object "${input.objectKey}" returned an empty response body.`);
  }

  await pipeline(response.Body as Readable, createWriteStream(input.localFilePath));
}

function buildContentDisposition(input: {
  disposition: "attachment" | "inline";
  fileName?: string;
}) {
  if (!input.fileName) {
    return input.disposition;
  }

  return `${input.disposition}; filename="${input.fileName.replace(/"/g, "")}"`;
}

export async function createSignedR2ObjectUrl(input: {
  objectKey: string;
  contentType: string;
  disposition?: "attachment" | "inline";
  fileName?: string;
}) {
  const client = getObjectStorageClient();
  const config = getRequiredR2Config();
  const expiresIn = Number(
    process.env.R2_SIGNED_URL_TTL_SECONDS ?? serverConfig.r2.defaultSignedUrlTtlSeconds,
  );

  return getSignedUrl(
    client,
    new GetObjectCommand({
      Bucket: config.bucket,
      Key: input.objectKey,
      ResponseContentType: input.contentType,
      ResponseContentDisposition: buildContentDisposition({
        disposition: input.disposition ?? "inline",
        fileName: input.fileName,
      }),
    }),
    {
      expiresIn,
    },
  );
}

export async function createSignedR2DownloadUrl(asset: StoredMediaAsset) {
  return createSignedR2ObjectUrl({
    objectKey: asset.storageKey,
    contentType: asset.mimeType,
    disposition: "attachment",
    fileName: asset.originalName,
  });
}

export async function cleanupTemporaryFile(filePath: string | null | undefined) {
  if (!filePath) {
    return;
  }

  await unlink(filePath).catch(() => undefined);
}

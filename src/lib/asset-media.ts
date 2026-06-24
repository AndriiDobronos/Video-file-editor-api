import path from "node:path";
import type { MediaMetadata } from "../types.js";

export type SupportedImageFormat = "png" | "jpeg" | "webp";
export type PreviewImageFormat = SupportedImageFormat | "gif";

const imageMimeTypeToFormatMap: Record<string, SupportedImageFormat> = {
  "image/png": "png",
  "image/jpeg": "jpeg",
  "image/jpg": "jpeg",
  "image/webp": "webp",
};

const imageExtensionToFormatMap: Record<string, SupportedImageFormat> = {
  ".png": "png",
  ".jpeg": "jpeg",
  ".jpg": "jpeg",
  ".webp": "webp",
};

const previewImageMimeTypeSet = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif",
]);

const previewImageExtensionSet = new Set([".png", ".jpeg", ".jpg", ".webp", ".gif"]);

export function buildAssetThumbnailUrl(assetId: string) {
  return `/api/v1/assets/${assetId}/thumbnail`;
}

export function resolveSupportedImageFormat(input: {
  mimeType?: string | null;
  fileName?: string | null;
}) {
  const normalizedMimeType = input.mimeType?.toLowerCase().trim();

  if (normalizedMimeType && normalizedMimeType in imageMimeTypeToFormatMap) {
    return imageMimeTypeToFormatMap[normalizedMimeType];
  }

  const extension = input.fileName ? path.extname(input.fileName).toLowerCase() : "";

  if (extension && extension in imageExtensionToFormatMap) {
    return imageExtensionToFormatMap[extension];
  }

  return null;
}

export function isSupportedImageAssetLike(input: {
  mimeType?: string | null;
  fileName?: string | null;
}) {
  return Boolean(resolveSupportedImageFormat(input));
}

export function isPreviewImageAssetLike(input: {
  mimeType?: string | null;
  fileName?: string | null;
}) {
  const normalizedMimeType = input.mimeType?.toLowerCase().trim();

  if (normalizedMimeType && previewImageMimeTypeSet.has(normalizedMimeType)) {
    return true;
  }

  const extension = input.fileName ? path.extname(input.fileName).toLowerCase() : "";
  return extension ? previewImageExtensionSet.has(extension) : false;
}

export function isVideoAssetLike(input: {
  mimeType?: string | null;
}) {
  return input.mimeType?.toLowerCase().trim().startsWith("video/") ?? false;
}

export function isPreviewableAsset(input: {
  mimeType?: string | null;
  fileName?: string | null;
  metadata: MediaMetadata | null;
}) {
  return Boolean(
    input.metadata?.videoCodec ||
      isPreviewImageAssetLike({
        mimeType: input.mimeType,
        fileName: input.fileName,
      }),
  );
}

export function getTargetImageExtension(format: SupportedImageFormat) {
  return format === "jpeg" ? ".jpg" : `.${format}`;
}

export function getTargetImageMimeType(format: SupportedImageFormat) {
  if (format === "png") {
    return "image/png";
  }

  if (format === "jpeg") {
    return "image/jpeg";
  }

  return "image/webp";
}

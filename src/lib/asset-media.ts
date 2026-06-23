import path from "node:path";
import type { MediaMetadata } from "../types.js";

export type SupportedImageFormat = "png" | "jpeg" | "webp";

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

export function isPreviewableAsset(input: {
  mimeType?: string | null;
  fileName?: string | null;
  metadata: MediaMetadata | null;
}) {
  return Boolean(
    input.metadata?.videoCodec ||
      resolveSupportedImageFormat({
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

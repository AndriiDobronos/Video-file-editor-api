import { createReadStream } from "node:fs";
import multipart from "@fastify/multipart";
import type { Queue } from "bullmq";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import { z } from "zod";
import {
  ensureAssetMetadataInspection,
  deleteAsset,
  ensureAssetThumbnail,
  getAssetDto,
  getAssetOrThrow,
  listAssetDtos,
  regenerateAssetThumbnail,
  saveIncomingUpload,
} from "../lib/filesystem.js";
import {
  clearFailedJobHistory,
  createAnimationExportJob,
  createAudioVolumeJob,
  createChangeSpeedJob,
  createCompressVideoJob,
  createConvertImageJob,
  createCropPadJob,
  createEditAudioTrackJob,
  createExtractAudioJob,
  createExtractFrameJob,
  createMergeJob,
  createNormalizeJob,
  createOverlayTextJob,
  createSubtitleBurnInJob,
  createTransitionMergeJob,
  createTrimJob,
  deleteJobHistory,
  getJobDto,
  listJobDtos,
} from "../lib/jobs.js";
import {
  createSignedR2DownloadUrl,
  createSignedR2ObjectUrl,
} from "../lib/object-storage.js";
import { toAssetDto } from "../lib/serializers.js";
import type { QueueJobData, QueueJobResult } from "../types.js";

const textOverlayColorSchema = z.string().refine(
  (value) =>
    /^(transparent|#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?|rgb\(\s*(?:25[0-5]|2[0-4]\d|1?\d?\d)\s*,\s*(?:25[0-5]|2[0-4]\d|1?\d?\d)\s*,\s*(?:25[0-5]|2[0-4]\d|1?\d?\d)\s*\)|rgba\(\s*(?:25[0-5]|2[0-4]\d|1?\d?\d)\s*,\s*(?:25[0-5]|2[0-4]\d|1?\d?\d)\s*,\s*(?:25[0-5]|2[0-4]\d|1?\d?\d)\s*,\s*(?:0|1(?:\.0+)?|0?\.\d+)\s*\))$/i.test(
      value.trim(),
    ),
  {
    message:
      "Use a supported color format such as #ffffff, #ffffffcc, rgb(255, 255, 255), rgba(17, 17, 17, 0.72), or transparent.",
  },
);

const trimJobSchema = z.object({
  assetId: z.string().min(1),
  startTime: z.number().min(0),
  endTime: z.number().gt(0),
});

const mergeJobSchema = z.object({
  sourceAssetIds: z.array(z.string().min(1)).min(2),
});

const transitionMergeJobSchema = z.object({
  sourceAssetIds: z.tuple([z.string().min(1), z.string().min(1)]),
  target: z.object({
    transition: z.enum(["crossfade", "fade-black"]),
    overlapSeconds: z.number().gt(0),
    audioMode: z.enum(["crossfade", "hard-cut"]),
  }),
});

const normalizeJobSchema = z.object({
  assetId: z.string().min(1),
  target: z.object({
    preset: z.enum([
      "hd-720p",
      "match-largest",
      "match-smallest",
      "match-average",
    ]),
    width: z.number().int().min(2).multipleOf(2),
    height: z.number().int().min(2).multipleOf(2),
    frameRate: z.number().positive(),
    audioSampleRate: z.number().int().positive(),
    audioChannels: z.number().int().positive(),
    videoCodec: z.literal("h264"),
    audioCodec: z.literal("aac"),
  }),
});

const compressVideoJobSchema = z.object({
  assetId: z.string().min(1),
  target: z.object({
    mode: z.enum(["simple", "advanced"]),
    preset: z.enum(["high-quality", "balanced", "small-file"]).optional(),
    crf: z.number().int().min(0).max(51).optional(),
    videoBitrateKbps: z.number().int().positive().optional(),
    audioBitrateKbps: z.number().int().positive().optional(),
    encoderPreset: z.enum([
      "ultrafast",
      "superfast",
      "veryfast",
      "faster",
      "fast",
      "medium",
      "slow",
    ]).optional(),
  }),
});

const animationExportJobSchema = z.object({
  assetId: z.string().min(1),
  target: z.object({
    format: z.enum(["gif", "webp"]),
    startTime: z.number().min(0),
    durationSeconds: z.number().gt(0),
    width: z.number().int().positive().max(1280).optional(),
    fps: z.number().int().min(1).max(30).optional(),
    quality: z.number().int().min(1).max(100).optional(),
  }),
});

const cropPadJobSchema = z.object({
  assetId: z.string().min(1),
  target: z.object({
    mode: z.enum(["crop", "pad"]),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    anchorX: z.enum(["left", "center", "right"]).optional(),
    anchorY: z.enum(["top", "center", "bottom"]).optional(),
    background: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  }),
});

const extractFrameJobSchema = z.object({
  assetId: z.string().min(1),
  target: z.object({
    timeSeconds: z.number().min(0),
    format: z.enum(["png", "jpeg", "webp"]),
    quality: z.number().int().min(1).max(100).optional(),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
    fit: z.enum(["contain", "cover", "stretch"]).optional(),
    background: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  }),
});

const extractAudioJobSchema = z.object({
  assetId: z.string().min(1),
  target: z.object({
    format: z.enum(["mp3", "m4a", "wav"]),
  }),
});

const editAudioTrackJobSchema = z.object({
  assetId: z.string().min(1),
  target: z.object({
    mode: z.enum(["mute", "replace"]),
    replacementAssetId: z.string().min(1).optional(),
    loopReplacement: z.boolean().optional(),
  }),
});

const changeSpeedJobSchema = z.object({
  assetId: z.string().min(1),
  target: z.object({
    rate: z.number().min(0.25).max(4),
  }),
});

const audioVolumeJobSchema = z.object({
  assetId: z.string().min(1),
  target: z
    .object({
      gainDb: z.number().min(-30).max(20).optional(),
      mute: z.boolean().optional(),
      startTime: z.number().min(0).optional(),
      endTime: z.number().gt(0).optional(),
      preventClipping: z.boolean().optional(),
    })
    .superRefine((target, context) => {
      if (target.mute !== true && typeof target.gainDb !== "number") {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Provide a gain value in dB or choose mute.",
          path: ["gainDb"],
        });
      }

      const hasStartTime = typeof target.startTime === "number";
      const hasEndTime = typeof target.endTime === "number";

      if (hasStartTime !== hasEndTime) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Custom ranges require both a start time and an end time.",
          path: ["startTime"],
        });
      }

      if (
        typeof target.startTime === "number" &&
        typeof target.endTime === "number" &&
        target.endTime <= target.startTime
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "End time must be greater than start time.",
          path: ["endTime"],
        });
      }
    }),
});

const overlayTextJobSchema = z.object({
  assetId: z.string().min(1),
  target: z.object({
    text: z.string().min(1),
    startTime: z.number().min(0).optional(),
    endTime: z.number().gt(0).optional(),
    fontSize: z.number().int().positive().max(512).optional(),
    fontColor: textOverlayColorSchema.optional(),
    backgroundColor: textOverlayColorSchema.optional(),
    horizontal: z.enum(["left", "center", "right"]).optional(),
    vertical: z.enum(["top", "center", "bottom"]).optional(),
  }),
});

const subtitleBurnInJobSchema = z.object({
  assetId: z.string().min(1),
  target: z.object({
    subtitleFileName: z.string().trim().min(1),
    subtitleContent: z.string().trim().min(1),
    fontSize: z.number().int().positive().max(512).optional(),
    fontColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
    outlineColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
    alignment: z.enum(["bottom-center", "bottom-left", "bottom-right", "top-center"]).optional(),
    marginVertical: z.number().int().min(0).max(400).optional(),
  }),
});

const convertImageJobSchema = z.object({
  assetId: z.string().min(1),
  target: z.object({
    format: z.enum(["png", "jpeg", "webp"]),
    quality: z.number().int().min(1).max(100).optional(),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
    fit: z.enum(["contain", "cover", "stretch"]).optional(),
    background: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  }),
});

type MediaRouteDependencies = {
  redis: Redis;
  queue: Queue<QueueJobData, QueueJobResult>;
};

export async function registerMediaRoutes(
  app: FastifyInstance,
  deps: MediaRouteDependencies,
) {
  await app.register(multipart, {
    limits: {
      fileSize: 1024 * 1024 * 1024,
      files: 12,
    },
  });

  app.get("/api/v1/assets", async () => {
    return {
      items: await listAssetDtos(deps.redis),
    };
  });

  app.get("/api/v1/assets/:assetId", async (request, reply) => {
    try {
      const params = request.params as { assetId: string };

      return {
        item: await getAssetDto(deps.redis, params.assetId),
      };
    } catch (error) {
      return reply.code(404).send({
        message: error instanceof Error ? error.message : "Asset was not found.",
      });
    }
  });

  app.get("/api/v1/assets/:assetId/metadata", async (request, reply) => {
    try {
      const params = request.params as { assetId: string };
      const asset = await ensureAssetMetadataInspection(deps.redis, params.assetId);

      return {
        item: {
          assetId: asset.id,
          metadata: asset.metadataInspection,
          summary: asset.metadata,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Asset metadata was not found.";
      const statusCode = message.includes("was not found") ? 404 : 500;

      return reply.code(statusCode).send({
        message,
      });
    }
  });

  app.post("/api/v1/assets/:assetId/metadata/refresh", async (request, reply) => {
    try {
      const params = request.params as { assetId: string };
      const asset = await ensureAssetMetadataInspection(deps.redis, params.assetId, {
        forceRefresh: true,
      });

      return reply.send({
        item: {
          assetId: asset.id,
          metadata: asset.metadataInspection,
          summary: asset.metadata,
        },
        message: `Metadata for "${asset.originalName}" was refreshed.`,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Asset metadata could not be refreshed.";
      const statusCode = message.includes("was not found") ? 404 : 500;

      return reply.code(statusCode).send({
        message,
      });
    }
  });

  app.get("/api/v1/assets/:assetId/download", async (request, reply) => {
    try {
      const params = request.params as { assetId: string };
      const asset = await getAssetOrThrow(deps.redis, params.assetId);

      if (asset.storageDriver === "r2") {
        return reply.redirect(await createSignedR2DownloadUrl(asset));
      }

      if (!asset.filePath) {
        throw new Error(`Asset "${asset.id}" is missing its local file path.`);
      }

      reply.header("Content-Type", asset.mimeType || "application/octet-stream");
      reply.header(
        "Content-Disposition",
        `attachment; filename="${asset.originalName.replace(/"/g, "")}"`,
      );

      return reply.send(createReadStream(asset.filePath));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Asset was not found.";
      const statusCode = message.includes("was not found") ? 404 : 500;

      return reply.code(statusCode).send({
        message,
      });
    }
  });

  app.get("/api/v1/assets/:assetId/thumbnail", async (request, reply) => {
    try {
      const params = request.params as { assetId: string };
      let asset = await getAssetOrThrow(deps.redis, params.assetId);

      if (!asset.thumbnailMimeType || (!asset.thumbnailStorageKey && !asset.thumbnailFilePath)) {
        asset = await ensureAssetThumbnail(deps.redis, asset);
      }

      if (!asset.thumbnailMimeType || (!asset.thumbnailStorageKey && !asset.thumbnailFilePath)) {
        return reply.code(404).send({
          message: `Asset "${asset.originalName}" does not have a thumbnail preview yet.`,
        });
      }

      if (asset.storageDriver === "r2") {
        if (!asset.thumbnailStorageKey) {
          throw new Error(`Asset "${asset.id}" is missing its thumbnail storage key.`);
        }

        return reply.redirect(
          await createSignedR2ObjectUrl({
            objectKey: asset.thumbnailStorageKey,
            contentType: asset.thumbnailMimeType,
            disposition: "inline",
            fileName: `${asset.originalName.replace(/\.[^.]+$/, "")}-thumbnail.jpg`,
          }),
        );
      }

      if (!asset.thumbnailFilePath) {
        throw new Error(`Asset "${asset.id}" is missing its local thumbnail path.`);
      }

      reply.header("Content-Type", asset.thumbnailMimeType);
      reply.header("Content-Disposition", "inline");

      return reply.send(createReadStream(asset.thumbnailFilePath));
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Asset thumbnail was not found.";
      const statusCode =
        message.includes("does not have a thumbnail") || message.includes("was not found")
          ? 404
          : 500;

      return reply.code(statusCode).send({
        message,
      });
    }
  });

  app.post("/api/v1/assets/:assetId/thumbnail/regenerate", async (request, reply) => {
    try {
      const params = request.params as { assetId: string };
      const asset = await regenerateAssetThumbnail(deps.redis, params.assetId);

      return reply.send({
        item: toAssetDto(asset),
        message: `Thumbnail preview for "${asset.originalName}" was regenerated.`,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Asset thumbnail could not be regenerated.";
      const statusCode = message.includes("was not found") ? 404 : 400;

      return reply.code(statusCode).send({
        message,
      });
    }
  });

  app.delete("/api/v1/assets/:assetId", async (request, reply) => {
    try {
      const params = request.params as { assetId: string };
      const asset = await deleteAsset(deps.redis, params.assetId);

      return reply.send({
        item: asset,
        message: `Asset "${asset.originalName}" was deleted.`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Asset could not be deleted.";
      const statusCode = message.includes("was not found") ? 404 : 500;

      return reply.code(statusCode).send({
        message,
      });
    }
  });

  app.post("/api/v1/uploads", async (request, reply) => {
    try {
      const createdAssets = [];

      for await (const part of request.parts()) {
        if (part.type !== "file") {
          continue;
        }

        createdAssets.push(toAssetDto(await saveIncomingUpload(deps.redis, part)));
      }

      if (createdAssets.length === 0) {
        return reply.code(400).send({
          message: "Upload at least one media file.",
        });
      }

      return reply.code(201).send({
        items: createdAssets,
      });
    } catch (error) {
      request.log.error(
        {
          error,
        },
        "Upload failed.",
      );

      return reply.code(500).send({
        message:
          error instanceof Error
            ? error.message
            : "Upload failed while writing to object storage.",
      });
    }
  });

  app.get("/api/v1/jobs", async () => {
    return {
      items: await listJobDtos(deps.redis),
    };
  });

  app.get("/api/v1/jobs/:jobId", async (request, reply) => {
    try {
      const params = request.params as { jobId: string };

      return {
        item: await getJobDto(deps.redis, params.jobId),
      };
    } catch (error) {
      return reply.code(404).send({
        message: error instanceof Error ? error.message : "Job was not found.",
      });
    }
  });

  app.delete("/api/v1/jobs/:jobId", async (request, reply) => {
    try {
      const params = request.params as { jobId: string };
      const job = await deleteJobHistory(deps.redis, deps.queue, params.jobId);

      return reply.send({
        item: job,
        message: `Job ${job.id.slice(0, 8)} was removed from queue history.`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Job could not be deleted.";
      const statusCode = message.includes("was not found")
        ? 404
        : message.includes("Only completed or failed jobs")
          ? 400
          : 500;

      return reply.code(statusCode).send({
        message,
      });
    }
  });

  app.post("/api/v1/jobs/clear-failed", async (_request, reply) => {
    try {
      const result = await clearFailedJobHistory(deps.redis, deps.queue);

      return reply.send({
        deletedCount: result.deletedCount,
        items: result.deletedJobs,
        message:
          result.deletedCount > 0
            ? `Removed ${result.deletedCount} failed job${result.deletedCount === 1 ? "" : "s"} from queue history.`
            : "There were no failed jobs to remove.",
      });
    } catch (error) {
      return reply.code(500).send({
        message:
          error instanceof Error
            ? error.message
            : "Failed queue history could not be cleared.",
      });
    }
  });

  app.post("/api/v1/jobs/trim", async (request, reply) => {
    const parsedBody = trimJobSchema.safeParse(request.body);

    if (!parsedBody.success) {
      return reply.code(400).send({
        message: "Trim payload is invalid.",
        issues: parsedBody.error.flatten(),
      });
    }

    try {
      const job = await createTrimJob(deps.redis, deps.queue, parsedBody.data);

      return reply.code(202).send({
        item: job,
      });
    } catch (error) {
      return reply.code(400).send({
        message: error instanceof Error ? error.message : "Trim job could not be queued.",
      });
    }
  });

  app.post("/api/v1/jobs/merge", async (request, reply) => {
    const parsedBody = mergeJobSchema.safeParse(request.body);

    if (!parsedBody.success) {
      return reply.code(400).send({
        message: "Merge payload is invalid.",
        issues: parsedBody.error.flatten(),
      });
    }

    try {
      const job = await createMergeJob(deps.redis, deps.queue, parsedBody.data);

      return reply.code(202).send({
        item: job,
      });
    } catch (error) {
      return reply.code(400).send({
        message: error instanceof Error ? error.message : "Merge job could not be queued.",
      });
    }
  });

  app.post("/api/v1/jobs/transition-merge", async (request, reply) => {
    const parsedBody = transitionMergeJobSchema.safeParse(request.body);

    if (!parsedBody.success) {
      return reply.code(400).send({
        message: "Transition merge payload is invalid.",
        issues: parsedBody.error.flatten(),
      });
    }

    try {
      const job = await createTransitionMergeJob(
        deps.redis,
        deps.queue,
        parsedBody.data,
      );

      return reply.code(202).send({
        item: job,
      });
    } catch (error) {
      return reply.code(400).send({
        message:
          error instanceof Error ? error.message : "Transition merge job could not be queued.",
      });
    }
  });

  app.post("/api/v1/jobs/normalize", async (request, reply) => {
    const parsedBody = normalizeJobSchema.safeParse(request.body);

    if (!parsedBody.success) {
      return reply.code(400).send({
        message: "Normalize payload is invalid.",
        issues: parsedBody.error.flatten(),
      });
    }

    try {
      const job = await createNormalizeJob(deps.redis, deps.queue, parsedBody.data);

      return reply.code(202).send({
        item: job,
      });
    } catch (error) {
      return reply.code(400).send({
        message:
          error instanceof Error ? error.message : "Normalize job could not be queued.",
      });
    }
  });

  app.post("/api/v1/jobs/compress-video", async (request, reply) => {
    const parsedBody = compressVideoJobSchema.safeParse(request.body);

    if (!parsedBody.success) {
      return reply.code(400).send({
        message: "Compress video payload is invalid.",
        issues: parsedBody.error.flatten(),
      });
    }

    try {
      const job = await createCompressVideoJob(deps.redis, deps.queue, parsedBody.data);

      return reply.code(202).send({
        item: job,
      });
    } catch (error) {
      return reply.code(400).send({
        message:
          error instanceof Error ? error.message : "Compress video job could not be queued.",
      });
    }
  });

  app.post("/api/v1/jobs/export-animation", async (request, reply) => {
    const parsedBody = animationExportJobSchema.safeParse(request.body);

    if (!parsedBody.success) {
      return reply.code(400).send({
        message: "Animation export payload is invalid.",
        issues: parsedBody.error.flatten(),
      });
    }

    try {
      const job = await createAnimationExportJob(deps.redis, deps.queue, parsedBody.data);

      return reply.code(202).send({
        item: job,
      });
    } catch (error) {
      return reply.code(400).send({
        message:
          error instanceof Error ? error.message : "Animation export job could not be queued.",
      });
    }
  });

  app.post("/api/v1/jobs/convert-image", async (request, reply) => {
    const parsedBody = convertImageJobSchema.safeParse(request.body);

    if (!parsedBody.success) {
      return reply.code(400).send({
        message: "Convert image payload is invalid.",
        issues: parsedBody.error.flatten(),
      });
    }

    try {
      const job = await createConvertImageJob(deps.redis, deps.queue, parsedBody.data);

      return reply.code(202).send({
        item: job,
      });
    } catch (error) {
      return reply.code(400).send({
        message:
          error instanceof Error ? error.message : "Convert image job could not be queued.",
      });
    }
  });

  app.post("/api/v1/jobs/extract-frame", async (request, reply) => {
    const parsedBody = extractFrameJobSchema.safeParse(request.body);

    if (!parsedBody.success) {
      return reply.code(400).send({
        message: "Extract frame payload is invalid.",
        issues: parsedBody.error.flatten(),
      });
    }

    try {
      const job = await createExtractFrameJob(deps.redis, deps.queue, parsedBody.data);

      return reply.code(202).send({
        item: job,
      });
    } catch (error) {
      return reply.code(400).send({
        message:
          error instanceof Error ? error.message : "Extract frame job could not be queued.",
      });
    }
  });

  app.post("/api/v1/jobs/extract-audio", async (request, reply) => {
    const parsedBody = extractAudioJobSchema.safeParse(request.body);

    if (!parsedBody.success) {
      return reply.code(400).send({
        message: "Extract audio payload is invalid.",
        issues: parsedBody.error.flatten(),
      });
    }

    try {
      const job = await createExtractAudioJob(deps.redis, deps.queue, parsedBody.data);

      return reply.code(202).send({
        item: job,
      });
    } catch (error) {
      return reply.code(400).send({
        message:
          error instanceof Error ? error.message : "Extract audio job could not be queued.",
      });
    }
  });

  app.post("/api/v1/jobs/edit-audio-track", async (request, reply) => {
    const parsedBody = editAudioTrackJobSchema.safeParse(request.body);

    if (!parsedBody.success) {
      return reply.code(400).send({
        message: "Audio track payload is invalid.",
        issues: parsedBody.error.flatten(),
      });
    }

    try {
      const job = await createEditAudioTrackJob(deps.redis, deps.queue, parsedBody.data);

      return reply.code(202).send({
        item: job,
      });
    } catch (error) {
      return reply.code(400).send({
        message:
          error instanceof Error ? error.message : "Audio track job could not be queued.",
      });
    }
  });

  app.post("/api/v1/jobs/change-speed", async (request, reply) => {
    const parsedBody = changeSpeedJobSchema.safeParse(request.body);

    if (!parsedBody.success) {
      return reply.code(400).send({
        message: "Change speed payload is invalid.",
        issues: parsedBody.error.flatten(),
      });
    }

    try {
      const job = await createChangeSpeedJob(deps.redis, deps.queue, parsedBody.data);

      return reply.code(202).send({
        item: job,
      });
    } catch (error) {
      return reply.code(400).send({
        message:
          error instanceof Error ? error.message : "Change speed job could not be queued.",
      });
    }
  });

  app.post("/api/v1/jobs/audio-volume", async (request, reply) => {
    const parsedBody = audioVolumeJobSchema.safeParse(request.body);

    if (!parsedBody.success) {
      return reply.code(400).send({
        message: "Audio volume payload is invalid.",
        issues: parsedBody.error.flatten(),
      });
    }

    try {
      const job = await createAudioVolumeJob(deps.redis, deps.queue, parsedBody.data);

      return reply.code(202).send({
        item: job,
      });
    } catch (error) {
      return reply.code(400).send({
        message:
          error instanceof Error ? error.message : "Audio volume job could not be queued.",
      });
    }
  });

  app.post("/api/v1/jobs/overlay-text", async (request, reply) => {
    const parsedBody = overlayTextJobSchema.safeParse(request.body);

    if (!parsedBody.success) {
      return reply.code(400).send({
        message: "Text overlay payload is invalid.",
        issues: parsedBody.error.flatten(),
      });
    }

    try {
      const job = await createOverlayTextJob(deps.redis, deps.queue, parsedBody.data);

      return reply.code(202).send({
        item: job,
      });
    } catch (error) {
      return reply.code(400).send({
        message:
          error instanceof Error ? error.message : "Text overlay job could not be queued.",
      });
    }
  });

  app.post("/api/v1/jobs/subtitle-burn-in", async (request, reply) => {
    const parsedBody = subtitleBurnInJobSchema.safeParse(request.body);

    if (!parsedBody.success) {
      return reply.code(400).send({
        message: "Subtitle burn-in payload is invalid.",
        issues: parsedBody.error.flatten(),
      });
    }

    try {
      const job = await createSubtitleBurnInJob(deps.redis, deps.queue, parsedBody.data);

      return reply.code(202).send({
        item: job,
      });
    } catch (error) {
      return reply.code(400).send({
        message:
          error instanceof Error
            ? error.message
            : "Subtitle burn-in job could not be queued.",
      });
    }
  });

  app.post("/api/v1/jobs/crop-pad", async (request, reply) => {
    const parsedBody = cropPadJobSchema.safeParse(request.body);

    if (!parsedBody.success) {
      return reply.code(400).send({
        message: "Crop / pad payload is invalid.",
        issues: parsedBody.error.flatten(),
      });
    }

    try {
      const job = await createCropPadJob(deps.redis, deps.queue, parsedBody.data);

      return reply.code(202).send({
        item: job,
      });
    } catch (error) {
      return reply.code(400).send({
        message:
          error instanceof Error ? error.message : "Crop / pad job could not be queued.",
      });
    }
  });
}

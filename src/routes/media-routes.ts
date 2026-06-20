import { createReadStream } from "node:fs";
import multipart from "@fastify/multipart";
import type { Queue } from "bullmq";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import { z } from "zod";
import {
  getAssetDto,
  getAssetOrThrow,
  listAssetDtos,
  saveIncomingUpload,
} from "../lib/filesystem.js";
import {
  createMergeJob,
  createTrimJob,
  getJobDto,
  listJobDtos,
} from "../lib/jobs.js";
import { createSignedR2DownloadUrl } from "../lib/object-storage.js";
import { toAssetDto } from "../lib/serializers.js";
import type { QueueJobData, QueueJobResult } from "../types.js";

const trimJobSchema = z.object({
  assetId: z.string().min(1),
  startTime: z.number().min(0),
  endTime: z.number().gt(0),
});

const mergeJobSchema = z.object({
  sourceAssetIds: z.array(z.string().min(1)).min(2),
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
}

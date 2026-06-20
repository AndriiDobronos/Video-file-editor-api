import {
  type ConnectionOptions,
  Queue,
  Worker,
  type Processor,
  type QueueOptions,
  type WorkerOptions,
} from "bullmq";
import { serverConfig } from "../config.js";
import type { JobType, QueueJobData, QueueJobResult } from "../types.js";

type VideoQueue = Queue<QueueJobData, QueueJobResult, JobType>;

function buildCommonQueueOptions(connection: ConnectionOptions): QueueOptions {
  return {
    connection,
    prefix: process.env.BULLMQ_QUEUE_PREFIX ?? serverConfig.queue.prefix,
    defaultJobOptions: {
      attempts: 2,
      backoff: {
        type: "fixed",
        delay: 3_000,
      },
      removeOnComplete: {
        age: serverConfig.queue.completedRetentionSeconds,
        count: 1_000,
      },
      removeOnFail: {
        age: serverConfig.queue.failedRetentionSeconds,
        count: 1_000,
      },
    },
  };
}

export function getVideoProcessingQueueName() {
  return process.env.BULLMQ_QUEUE_NAME ?? serverConfig.queue.name;
}

export function createVideoProcessingQueue(connection: ConnectionOptions): VideoQueue {
  return new Queue<QueueJobData, QueueJobResult, JobType>(
    getVideoProcessingQueueName(),
    buildCommonQueueOptions(connection),
  );
}

export function createVideoProcessingWorker(
  connection: ConnectionOptions,
  processor: Processor<QueueJobData, QueueJobResult, JobType>,
) {
  const workerOptions: WorkerOptions = {
    connection,
    concurrency: Number(
      process.env.BULLMQ_WORKER_CONCURRENCY ?? serverConfig.queue.workerConcurrency,
    ),
    prefix: process.env.BULLMQ_QUEUE_PREFIX ?? serverConfig.queue.prefix,
  };

  return new Worker<QueueJobData, QueueJobResult, JobType>(
    getVideoProcessingQueueName(),
    processor,
    workerOptions,
  );
}

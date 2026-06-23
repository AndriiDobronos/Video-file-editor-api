import path from "node:path";
import { fileURLToPath } from "node:url";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(currentDir, "..");
const storageRoot = path.join(projectRoot, "storage");

export const serverConfig = {
  projectRoot,
  storageRoot,
  uploadsDir: path.join(storageRoot, "uploads"),
  outputsDir: path.join(storageRoot, "outputs"),
  thumbnailsDir: path.join(storageRoot, "thumbnails"),
  tempDir: path.join(storageRoot, "temp"),
  defaultPort: 4001,
  defaultHost: "0.0.0.0",
  defaultCorsOrigin: "http://localhost:3000",
  redis: {
    host: "127.0.0.1",
    port: 6379,
    db: 0,
  },
  queue: {
    name: "video-processing",
    prefix: "video-file-editor",
    workerConcurrency: 1,
    completedRetentionSeconds: 60 * 60 * 24,
    failedRetentionSeconds: 60 * 60 * 24 * 7,
  },
  redisKeys: {
    assetRecordPrefix: "vfe:asset",
    assetIndex: "vfe:assets:index",
    jobRecordPrefix: "vfe:job",
    jobIndex: "vfe:jobs:index",
  },
  r2: {
    defaultRegion: "auto",
    defaultSignedUrlTtlSeconds: 60 * 60,
  },
};

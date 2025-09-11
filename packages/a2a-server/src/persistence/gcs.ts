/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { Storage } from '@google-cloud/storage';
import * as tar from 'tar';
import * as fse from 'fs-extra';
import { promises as fsPromises, createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Task as SDKTask } from '@a2a-js/sdk';
import type { TaskStore } from '@a2a-js/sdk/server';
import type { AgentSettings } from '../types.js';
import { logger } from '../utils/logger.js';
import { setTargetDir } from '../config/config.js';
import { v4 as uuidv4 } from 'uuid';

const getTmpArchiveFilename = (taskId: string): string =>
  `task-${taskId}-workspace-${uuidv4()}.tar.gz`;

export class GCSTaskStore implements TaskStore {
  private storage: Storage;
  private bucketName: string;
  private bucketInitialized: Promise<void>;

  constructor(bucketName: string) {
    if (!bucketName) {
      throw new Error('GCS bucket name is required.');
    }
    this.storage = new Storage();
    this.bucketName = bucketName;
    logger.info(`GCSTaskStore initializing with bucket: ${this.bucketName}`);
    // Prerequisites: user account or service account must have storage admin IAM role
    // and the bucket name must be unique.
    this.bucketInitialized = this.initializeBucket();
  }

  private async initializeBucket(): Promise<void> {
    try {
      const [buckets] = await this.storage.getBuckets();
      const exists = buckets.some((bucket) => bucket.name === this.bucketName);

      if (!exists) {
        logger.info(
          `Bucket ${this.bucketName} does not exist in the list. Attempting to create...`,
        );
        try {
          await this.storage.createBucket(this.bucketName);
          logger.info(`Bucket ${this.bucketName} created successfully.`);
        } catch (createError) {
          logger.info(
            `Failed to create bucket ${this.bucketName}: ${createError}`,
          );
          throw new Error(
            `Failed to create GCS bucket ${this.bucketName}: ${createError}`,
          );
        }
      } else {
        logger.info(`Bucket ${this.bucketName} exists.`);
      }
    } catch (error) {
      logger.info(
        `Error during bucket initialization for ${this.bucketName}: ${error}`,
      );
      throw new Error(
        `Failed to initialize GCS bucket ${this.bucketName}: ${error}`,
      );
    }
  }

  private async ensureBucketInitialized(): Promise<void> {
    await this.bucketInitialized;
  }

  private getContextIdIndexPath(taskId: string): string {
    return `tasks/${taskId}/contextId.txt`;
  }

  private getTaskObjectPath(contextId: string, taskId: string): string {
    return `contexts/${contextId}/${taskId}/task.json`;
  }

  private getWorkspaceObjectPath(contextId: string, taskId: string): string {
    return `contexts/${contextId}/${taskId}/workspace.tar.gz`;
  }

  async save(task: SDKTask): Promise<void> {
    await this.ensureBucketInitialized();
    const taskId = task.id;
    const contextId = task.contextId;

    if (!contextId) {
      throw new Error(`Task ${taskId} is missing contextId.`);
    }

    const workDir = process.cwd();

    const contextIdIndexPath = this.getContextIdIndexPath(taskId);
    const taskObjectPath = this.getTaskObjectPath(contextId, taskId);
    const workspaceObjectPath = this.getWorkspaceObjectPath(contextId, taskId);

    try {
      // 1. Save contextId index file
      const contextIdIndexFile = this.storage
        .bucket(this.bucketName)
        .file(contextIdIndexPath);
      await contextIdIndexFile.save(contextId, {
        contentType: 'text/plain',
      });
      logger.info(
        `Task ${taskId} index saved to GCS: gs://${this.bucketName}/${contextIdIndexPath}`,
      );

      // 2. Save task object as JSON
      const jsonString = JSON.stringify(task, null, 2);
      const taskObjectFile = this.storage
        .bucket(this.bucketName)
        .file(taskObjectPath);
      await taskObjectFile.save(jsonString, {
        contentType: 'application/json',
      });
      logger.info(
        `Task ${taskId} object saved to GCS: gs://${this.bucketName}/${taskObjectPath}`,
      );

      // 3. Save workspace
      if (await fse.pathExists(workDir)) {
        const entries = await fsPromises.readdir(workDir);
        if (entries.length > 0) {
          const tmpArchiveFile = join(tmpdir(), getTmpArchiveFilename(taskId));
          try {
            await tar.c(
              {
                gzip: true,
                file: tmpArchiveFile,
                cwd: workDir,
                portable: true,
              },
              entries,
            );

            if (!(await fse.pathExists(tmpArchiveFile))) {
              throw new Error(
                `tar.c command failed to create ${tmpArchiveFile}`,
              );
            }

            const workspaceFile = this.storage
              .bucket(this.bucketName)
              .file(workspaceObjectPath);
            const sourceStream = createReadStream(tmpArchiveFile);
            const destStream = workspaceFile.createWriteStream({
              contentType: 'application/gzip',
              resumable: true,
            });

            await new Promise<void>((resolve, reject) => {
              sourceStream.on('error', (err) => {
                logger.error(
                  `Error in source stream for ${tmpArchiveFile}:`,
                  err,
                );
                if (!destStream.destroyed) {
                  destStream.destroy(err);
                }
                reject(err);
              });

              destStream.on('error', (err) => {
                logger.error(
                  `Error in GCS dest stream for ${workspaceObjectPath}:`,
                  err,
                );
                reject(err);
              });

              destStream.on('finish', () => {
                logger.info(
                  `GCS destStream finished for ${workspaceObjectPath}`,
                );
                resolve();
              });

              logger.info(
                `Piping ${tmpArchiveFile} to GCS object ${workspaceObjectPath}`,
              );
              sourceStream.pipe(destStream);
            });
            logger.info(
              `Task ${taskId} workspace saved to GCS: gs://${this.bucketName}/${workspaceObjectPath}`,
            );
          } finally {
            if (await fse.pathExists(tmpArchiveFile)) {
              await fse.remove(tmpArchiveFile);
            }
          }
        } else {
          logger.info(
            `Workspace directory ${workDir} is empty, skipping workspace save for task ${taskId}.`,
          );
        }
      } else {
        logger.info(
          `Workspace directory ${workDir} not found, skipping workspace save for task ${taskId}.`,
        );
      }
    } catch (error) {
      logger.error(`Failed to save task ${taskId} to GCS:`, error);
      throw error;
    }
  }

  async load(taskId: string): Promise<SDKTask | undefined> {
    await this.ensureBucketInitialized();

    const contextIdIndexPath = this.getContextIdIndexPath(taskId);

    try {
      // 1. Load contextId from index
      const contextIdIndexFile = this.storage
        .bucket(this.bucketName)
        .file(contextIdIndexPath);
      const [indexExists] = await contextIdIndexFile.exists();
      if (!indexExists) {
        logger.info(`Task index for ${taskId} not found in GCS.`);
        return undefined;
      }
      const [contextIdBuffer] = await contextIdIndexFile.download();
      const contextId = contextIdBuffer.toString();
      logger.info(
        `Task index for ${taskId} loaded from GCS. ContextId: ${contextId}`,
      );

      // 2. Load task object
      const taskObjectPath = this.getTaskObjectPath(contextId, taskId);
      const taskObjectFile = this.storage
        .bucket(this.bucketName)
        .file(taskObjectPath);
      const [taskExists] = await taskObjectFile.exists();
      if (!taskExists) {
        logger.error(
          `Task index found for ${taskId}, but task object not found at ${taskObjectPath}.`,
        );
        throw new Error(
          `Inconsistent state: Task object not found for task ${taskId}`,
        );
      }
      const [taskJsonBuffer] = await taskObjectFile.download();
      const task = JSON.parse(taskJsonBuffer.toString()) as SDKTask;
      logger.info(`Task ${taskId} object loaded from GCS.`);

      // 3. Restore workspace
      // This uses the custom __persistedState for now, which will be removed in a later step.
      const agentSettings = (task.metadata as { [key: string]: unknown })?.[
        '__persistedState'
      ] as AgentSettings | undefined;
      const workDir = setTargetDir(agentSettings);
      await fse.ensureDir(workDir);

      const workspaceObjectPath = this.getWorkspaceObjectPath(
        contextId,
        taskId,
      );
      const workspaceFile = this.storage
        .bucket(this.bucketName)
        .file(workspaceObjectPath);
      const [workspaceExists] = await workspaceFile.exists();

      if (workspaceExists) {
        const tmpArchiveFile = join(tmpdir(), getTmpArchiveFilename(taskId));
        try {
          await workspaceFile.download({ destination: tmpArchiveFile });
          await tar.x({ file: tmpArchiveFile, cwd: workDir });
          logger.info(
            `Task ${taskId} workspace restored from GCS to ${workDir}`,
          );
        } finally {
          if (await fse.pathExists(tmpArchiveFile)) {
            await fse.remove(tmpArchiveFile);
          }
        }
      } else {
        logger.info(`Task ${taskId} workspace archive not found in GCS.`);
      }

      return task;
    } catch (error) {
      logger.error(`Failed to load task ${taskId} from GCS:`, error);
      throw error;
    }
  }
}

export class NoOpTaskStore implements TaskStore {
  constructor(private realStore: TaskStore) {}

  async save(task: SDKTask): Promise<void> {
    logger.info(`[NoOpTaskStore] save called for task ${task.id} - IGNORED`);
    return Promise.resolve();
  }

  async load(taskId: string): Promise<SDKTask | undefined> {
    logger.info(
      `[NoOpTaskStore] load called for task ${taskId}, delegating to real store.`,
    );
    return this.realStore.load(taskId);
  }
}

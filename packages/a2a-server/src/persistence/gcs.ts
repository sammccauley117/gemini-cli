/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { Storage } from '@google-cloud/storage';
import * as tar from 'tar';
import * as fse from 'fs-extra';
import { promises as fsPromises } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Message, Task as SDKTask } from '@a2a-js/sdk';
import type { TaskStore } from '@a2a-js/sdk/server';
import { logger } from '../utils/logger.js';
import { setTargetDir } from '../config/config.js';
import { getPersistedState } from '../types.js';
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
    this.bucketInitialized = this.initializeBucket();
  }

  private async initializeBucket(): Promise<void> {
    try {
      const [buckets] = await this.storage.getBuckets();
      const exists = buckets.some((bucket) => bucket.name === this.bucketName);

      if (!exists) {
        logger.info(
          `Bucket ${this.bucketName} does not exist. Attempting to create...`,
        );
        await this.storage.createBucket(this.bucketName);
        logger.info(`Bucket ${this.bucketName} created successfully.`);
      } else {
        logger.info(`Bucket ${this.bucketName} exists.`);
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown GCS error';
      logger.error(
        `Error during bucket initialization for ${this.bucketName}: ${message}`,
      );
      throw new Error(
        `Failed to initialize GCS bucket ${this.bucketName}: ${message}`,
      );
    }
  }

  private async ensureBucketInitialized(): Promise<void> {
    await this.bucketInitialized;
  }

  private getTaskPath(contextId: string, taskId: string, fileName: string) {
    return `contexts/${contextId}/${taskId}/${fileName}`;
  }

  private getIndexPath(taskId: string) {
    return `tasks/${taskId}/contextId.txt`;
  }

  private getContextHistoryPath(contextId: string) {
    return `contexts/${contextId}/context_history.json`;
  }

  async save(task: SDKTask): Promise<void> {
    await this.ensureBucketInitialized();
    const { id: taskId, contextId } = task;

    if (!contextId) {
      throw new Error(`Task ${taskId} is missing a contextId.`);
    }

    const workDir = process.cwd();
    const bucket = this.storage.bucket(this.bucketName);

    // 1. Save the complete task object as task.json
    const taskJsonPath = this.getTaskPath(contextId, taskId, 'task.json');
    const taskJsonFile = bucket.file(taskJsonPath);
    await taskJsonFile.save(JSON.stringify(task, null, 2), {
      contentType: 'application/json',
    });
    logger.info(
      `Task ${taskId} JSON saved to GCS: gs://${this.bucketName}/${taskJsonPath}`,
    );

    // 2. Save the workspace tarball
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

          const workspacePath = this.getTaskPath(
            contextId,
            taskId,
            'workspace.tar.gz',
          );
          await bucket.upload(tmpArchiveFile, {
            destination: workspacePath,
            contentType: 'application/gzip',
          });
          logger.info(
            `Task ${taskId} workspace saved to GCS: gs://${this.bucketName}/${workspacePath}`,
          );
        } finally {
          await fse.remove(tmpArchiveFile);
        }
      }
    }

    // 3. Create the index pointer file
    const indexPath = this.getIndexPath(taskId);
    const indexFile = bucket.file(indexPath);
    await indexFile.save(contextId, { contentType: 'text/plain' });
    logger.info(
      `Task ${taskId} index saved to GCS: gs://${this.bucketName}/${indexPath}`,
    );

    // 4. Append to context_history.json
    const historyPath = this.getContextHistoryPath(contextId);
    const historyFile = bucket.file(historyPath);
    let history: Message[] = [];
    try {
      const [exists] = await historyFile.exists();
      if (exists) {
        const [content] = await historyFile.download();
        history = JSON.parse(content.toString());
      }
    } catch (e) {
      logger.warn(`Could not read existing history file: ${historyPath}`, e);
    }

    // Append only new messages from the task's history
    if (task.history && task.history.length > 0) {
      const existingMessageIds = new Set(history.map((m) => m.messageId));
      const newMessages = task.history.filter(
        (m) => !existingMessageIds.has(m.messageId),
      );
      if (newMessages.length > 0) {
        history.push(...newMessages);
        await historyFile.save(JSON.stringify(history, null, 2), {
          contentType: 'application/json',
        });
        logger.info(
          `Appended ${newMessages.length} message(s) to context history: ${historyPath}`,
        );
      }
    }
  }

  async load(taskId: string): Promise<SDKTask | undefined> {
    await this.ensureBucketInitialized();
    const bucket = this.storage.bucket(this.bucketName);

    // 1. Read the index to get the contextId
    const indexPath = this.getIndexPath(taskId);
    const indexFile = bucket.file(indexPath);
    const [indexExists] = await indexFile.exists();
    if (!indexExists) {
      logger.warn(`Index file not found for task ${taskId} at ${indexPath}`);
      return undefined;
    }
    const [contextIdBuffer] = await indexFile.download();
    const contextId = contextIdBuffer.toString();

    // 2. Read and deserialize task.json
    const taskJsonPath = this.getTaskPath(contextId, taskId, 'task.json');
    const taskJsonFile = bucket.file(taskJsonPath);
    const [taskJsonExists] = await taskJsonFile.exists();
    if (!taskJsonExists) {
      logger.error(
        `Task JSON not found for task ${taskId} at ${taskJsonPath} despite index entry.`,
      );
      return undefined;
    }
    const [taskJsonContent] = await taskJsonFile.download();
    const sdkTask = JSON.parse(taskJsonContent.toString()) as SDKTask;
    logger.info(`Task ${taskId} JSON loaded from GCS.`);

    // 3. Download and extract workspace.tar.gz
    const persistedState = getPersistedState(sdkTask.metadata || {});
    if (!persistedState) {
      throw new Error(
        `Loaded metadata for task ${taskId} is missing internal persisted state.`,
      );
    }
    const workDir = setTargetDir(persistedState._agentSettings);
    await fse.ensureDir(workDir);

    const workspacePath = this.getTaskPath(
      contextId,
      taskId,
      'workspace.tar.gz',
    );
    const workspaceFile = bucket.file(workspacePath);
    const [workspaceExists] = await workspaceFile.exists();

    if (workspaceExists) {
      const tmpArchiveFile = join(tmpdir(), getTmpArchiveFilename(taskId));
      try {
        await workspaceFile.download({ destination: tmpArchiveFile });
        await tar.x({ file: tmpArchiveFile, cwd: workDir });
        logger.info(`Task ${taskId} workspace restored from GCS to ${workDir}`);
      } finally {
        await fse.remove(tmpArchiveFile);
      }
    } else {
      logger.info(`Task ${taskId} workspace archive not found in GCS.`);
    }

    return sdkTask;
  }

  async getContextHistory(contextId: string): Promise<Message[]> {
    await this.ensureBucketInitialized();
    const historyPath = this.getContextHistoryPath(contextId);
    const historyFile = this.storage.bucket(this.bucketName).file(historyPath);
    const [exists] = await historyFile.exists();
    if (!exists) {
      return [];
    }
    const [content] = await historyFile.download();
    return JSON.parse(content.toString()) as Message[];
  }
}

/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { Storage } from '@google-cloud/storage';
import * as fse from 'fs-extra';
import { promises as fsPromises } from 'node:fs';
import * as tar from 'tar';
import type { Task as SDKTask } from '@a2a-js/sdk';
import type { Mocked, MockedClass, Mock } from 'vitest';
import { describe, it, expect, beforeEach, vi } from 'vitest';

import { GCSTaskStore } from './gcs.js';
import * as configModule from '../config/config.js';
import { getPersistedState } from '../types.js';

// Mock dependencies
vi.mock('@google-cloud/storage');
vi.mock('fs-extra', () => ({
  pathExists: vi.fn(),
  readdir: vi.fn(),
  remove: vi.fn(),
  ensureDir: vi.fn(),
}));
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    promises: {
      ...actual.promises,
      readdir: vi.fn(),
    },
  };
});
vi.mock('tar');
vi.mock('uuid');
vi.mock('../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));
vi.mock('../config/config.js', () => ({
  setTargetDir: vi.fn(),
}));
vi.mock('../types.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../types.js')>();
  return {
    ...actual,
    getPersistedState: vi.fn(),
  };
});

const mockStorage = Storage as MockedClass<typeof Storage>;
const mockFse = fse as Mocked<typeof fse>;
const mockTar = tar as Mocked<typeof tar>;
const mockSetTargetDir = configModule.setTargetDir as Mock;
const mockGetPersistedState = getPersistedState as Mock;

type MockFile = {
  save: Mock<(data: Buffer | string, options?: object) => Promise<void>>;
  download: Mock<() => Promise<[Buffer]>>;
  exists: Mock<() => Promise<[boolean]>>;
};

type MockBucket = {
  file: Mock<(path: string) => MockFile>;
  upload: Mock<(path: string, options?: object) => Promise<void>>;
  name: string;
};

type MockStorageInstance = {
  bucket: Mock<(name: string) => MockBucket>;
  getBuckets: Mock<() => Promise<[Array<{ name: string }>]>>;
  createBucket: Mock<(name: string) => Promise<[MockBucket]>>;
};

describe('GCSTaskStore', () => {
  let bucketName: string;
  let mockBucket: MockBucket;
  let mockFile: MockFile;
  let mockStorageInstance: MockStorageInstance;

  beforeEach(() => {
    vi.clearAllMocks();
    bucketName = 'test-bucket';

    mockFile = {
      save: vi.fn().mockResolvedValue(undefined),
      download: vi.fn().mockResolvedValue([Buffer.from('')]),
      exists: vi.fn().mockResolvedValue([true]),
    };

    mockBucket = {
      file: vi.fn().mockReturnValue(mockFile),
      upload: vi.fn().mockResolvedValue(undefined),
      name: bucketName,
    };

    mockStorageInstance = {
      bucket: vi.fn().mockReturnValue(mockBucket),
      getBuckets: vi.fn().mockResolvedValue([[{ name: bucketName }]]),
      createBucket: vi.fn().mockResolvedValue([mockBucket]),
    };
    mockStorage.mockReturnValue(mockStorageInstance as unknown as Storage);

    mockSetTargetDir.mockReturnValue('/tmp/workdir');
    mockGetPersistedState.mockReturnValue({
      _agentSettings: {},
      _taskState: 'submitted',
    });
    (fse.pathExists as Mock).mockResolvedValue(true);
    (fsPromises.readdir as Mock).mockResolvedValue(['file1.txt']);
    mockTar.c.mockResolvedValue(undefined);
    mockTar.x.mockResolvedValue(undefined);
    mockFse.remove.mockResolvedValue(undefined);
    mockFse.ensureDir.mockResolvedValue(undefined);
  });

  describe('save', () => {
    const mockTask: SDKTask = {
      id: 'task1',
      contextId: 'ctx1',
      kind: 'task',
      status: { state: 'working' },
      metadata: {},
      history: [],
    };

    it('should save task.json, workspace, index, and history', async () => {
      const store = new GCSTaskStore(bucketName);
      await store.save(mockTask);

      // 1. Save task.json
      expect(mockBucket.file).toHaveBeenCalledWith(
        'contexts/ctx1/task1/task.json',
      );
      expect(mockFile.save).toHaveBeenCalledWith(
        JSON.stringify(mockTask, null, 2),
        { contentType: 'application/json' },
      );

      // 2. Save workspace
      expect(mockTar.c).toHaveBeenCalledTimes(1);
      expect(mockBucket.upload).toHaveBeenCalledTimes(1);

      // 3. Save index
      expect(mockBucket.file).toHaveBeenCalledWith('tasks/task1/contextId.txt');
      expect(mockFile.save).toHaveBeenCalledWith('ctx1', {
        contentType: 'text/plain',
      });

      // 4. Save history
      expect(mockBucket.file).toHaveBeenCalledWith(
        'contexts/ctx1/context_history.json',
      );
    });
  });

  describe('load', () => {
    it('should load task by reading index and then task data', async () => {
      const mockSdkTask = {
        id: 'task1',
        contextId: 'ctx1',
        metadata: { __persistedState: { _agentSettings: {} } },
      };
      const indexFile = {
        ...mockFile,
        exists: vi.fn().mockResolvedValue([true]),
        download: vi.fn().mockResolvedValue([Buffer.from('ctx1')]),
      };
      const taskFile = {
        ...mockFile,
        exists: vi.fn().mockResolvedValue([true]),
        download: vi
          .fn()
          .mockResolvedValue([Buffer.from(JSON.stringify(mockSdkTask))]),
      };
      const workspaceFile = {
        ...mockFile,
        exists: vi.fn().mockResolvedValue([true]),
        download: vi.fn().mockResolvedValue([Buffer.from('workspace data')]),
      };

      mockBucket.file.mockImplementation((path) => {
        if (path.startsWith('tasks/')) return indexFile;
        if (path.endsWith('task.json')) return taskFile;
        if (path.endsWith('workspace.tar.gz')) return workspaceFile;
        return mockFile;
      });

      const store = new GCSTaskStore(bucketName);
      const task = await store.load('task1');

      expect(task).toEqual(mockSdkTask);
      expect(mockBucket.file).toHaveBeenCalledWith('tasks/task1/contextId.txt');
      expect(mockBucket.file).toHaveBeenCalledWith(
        'contexts/ctx1/task1/task.json',
      );
      expect(mockBucket.file).toHaveBeenCalledWith(
        'contexts/ctx1/task1/workspace.tar.gz',
      );
      expect(mockTar.x).toHaveBeenCalledTimes(1);
    });

    it('should return undefined if index file not found', async () => {
      mockFile.exists.mockResolvedValue([false]);
      const store = new GCSTaskStore(bucketName);
      const task = await store.load('task1');
      expect(task).toBeUndefined();
    });
  });

  describe('getContextHistory', () => {
    it('should retrieve and parse history file', async () => {
      const history = [{ messageId: 'msg1' }];
      mockFile.exists.mockResolvedValue([true]);
      mockFile.download.mockResolvedValue([
        Buffer.from(JSON.stringify(history)),
      ]);
      const store = new GCSTaskStore(bucketName);
      const result = await store.getContextHistory('ctx1');
      expect(result).toEqual(history);
      expect(mockBucket.file).toHaveBeenCalledWith(
        'contexts/ctx1/context_history.json',
      );
    });

    it('should return empty array if history file does not exist', async () => {
      mockFile.exists.mockResolvedValue([false]);
      const store = new GCSTaskStore(bucketName);
      const result = await store.getContextHistory('ctx1');
      expect(result).toEqual([]);
    });
  });
});

/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { Storage } from '@google-cloud/storage';
import * as fse from 'fs-extra';
import { promises as fsPromises, createReadStream } from 'node:fs';
import * as tar from 'tar';
import { v4 as uuidv4 } from 'uuid';
import type { Task as SDKTask } from '@a2a-js/sdk';
import type { TaskStore } from '@a2a-js/sdk/server';
import type { Mocked, MockedClass, Mock } from 'vitest';
import { describe, it, expect, beforeEach, vi } from 'vitest';

import { GCSTaskStore, NoOpTaskStore } from './gcs.js';
import { logger } from '../utils/logger.js';
import * as configModule from '../config/config.js';

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
    createReadStream: vi.fn(),
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
vi.mock('node:stream/promises', () => ({
  pipeline: vi.fn(),
}));

const mockStorage = Storage as MockedClass<typeof Storage>;
const mockFse = fse as Mocked<typeof fse>;
const mockCreateReadStream = createReadStream as Mock;
const mockTar = tar as Mocked<typeof tar>;
const mockUuidv4 = uuidv4 as Mock;
const mockSetTargetDir = configModule.setTargetDir as Mock;

type MockWriteStream = {
  on: Mock<
    (event: string, cb: (error?: Error | null) => void) => MockWriteStream
  >;
  destroy: Mock<() => void>;
  destroyed: boolean;
};

type MockFile = {
  save: Mock<(data: Buffer | string, options?: object) => Promise<void>>;
  download: Mock<() => Promise<[Buffer]>>;
  exists: Mock<() => Promise<[boolean]>>;
  createWriteStream: Mock<() => MockWriteStream>;
};

type MockBucket = {
  exists: Mock<() => Promise<[boolean]>>;
  file: Mock<(path: string) => MockFile>;
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
  let mockWriteStream: MockWriteStream;
  let mockStorageInstance: MockStorageInstance;

  beforeEach(() => {
    vi.clearAllMocks();
    bucketName = 'test-bucket';

    mockWriteStream = {
      on: vi.fn((event, cb) => {
        if (event === 'finish') setTimeout(cb, 0); // Simulate async finish
        return mockWriteStream;
      }),
      destroy: vi.fn(),
      destroyed: false,
    };

    mockFile = {
      save: vi.fn().mockResolvedValue(undefined),
      download: vi.fn().mockResolvedValue([Buffer.from('')]),
      exists: vi.fn().mockResolvedValue([true]),
      createWriteStream: vi.fn().mockReturnValue(mockWriteStream),
    };

    mockBucket = {
      exists: vi.fn().mockResolvedValue([true]),
      file: vi.fn().mockReturnValue(mockFile),
      name: bucketName,
    };

    mockStorageInstance = {
      bucket: vi.fn().mockReturnValue(mockBucket),
      getBuckets: vi.fn().mockResolvedValue([[{ name: bucketName }]]),
      createBucket: vi.fn().mockResolvedValue([mockBucket]),
    };
    mockStorage.mockReturnValue(mockStorageInstance as unknown as Storage);

    mockUuidv4.mockReturnValue('test-uuid');
    mockSetTargetDir.mockReturnValue('/tmp/workdir');
    (fse.pathExists as Mock).mockResolvedValue(true);
    (fsPromises.readdir as Mock).mockResolvedValue(['file1.txt']);
    mockTar.c.mockResolvedValue(undefined);
    mockTar.x.mockResolvedValue(undefined);
    mockFse.remove.mockResolvedValue(undefined);
    mockFse.ensureDir.mockResolvedValue(undefined);
    mockCreateReadStream.mockReturnValue({ on: vi.fn(), pipe: vi.fn() });
  });

  describe('Constructor & Initialization', () => {
    it('should initialize and check bucket existence', async () => {
      const store = new GCSTaskStore(bucketName);
      await store['ensureBucketInitialized']();
      expect(mockStorage).toHaveBeenCalledTimes(1);
      expect(mockStorageInstance.getBuckets).toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('Bucket test-bucket exists'),
      );
    });

    it('should create bucket if it does not exist', async () => {
      mockStorageInstance.getBuckets.mockResolvedValue([[]]);
      const store = new GCSTaskStore(bucketName);
      await store['ensureBucketInitialized']();
      expect(mockStorageInstance.createBucket).toHaveBeenCalledWith(bucketName);
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('Bucket test-bucket created successfully'),
      );
    });

    it('should throw if bucket creation fails', async () => {
      mockStorageInstance.getBuckets.mockResolvedValue([[]]);
      mockStorageInstance.createBucket.mockRejectedValue(
        new Error('Create failed'),
      );
      const store = new GCSTaskStore(bucketName);
      await expect(store['ensureBucketInitialized']()).rejects.toThrow(
        'Failed to create GCS bucket test-bucket: Error: Create failed',
      );
    });
  });

  describe('save', () => {
    const mockTask: SDKTask = {
      id: 'task1',
      contextId: 'ctx1',
      kind: 'task',
      status: { state: 'working' },
      metadata: {},
      history: [],
      artifacts: [],
    };

    it('should save contextId index, task object, and workspace', async () => {
      const store = new GCSTaskStore(bucketName);
      await store.save(mockTask);

      // 1. Save contextId index
      expect(mockBucket.file).toHaveBeenCalledWith('tasks/task1/contextId.txt');
      expect(mockFile.save).toHaveBeenCalledWith('ctx1', {
        contentType: 'text/plain',
      });

      // 2. Save task object
      expect(mockBucket.file).toHaveBeenCalledWith(
        'contexts/ctx1/task1/task.json',
      );
      expect(mockFile.save).toHaveBeenCalledWith(
        JSON.stringify(mockTask, null, 2),
        { contentType: 'application/json' },
      );

      // 3. Save workspace
      expect(mockBucket.file).toHaveBeenCalledWith(
        'contexts/ctx1/task1/workspace.tar.gz',
      );
      expect(mockTar.c).toHaveBeenCalledTimes(1);
      expect(mockCreateReadStream).toHaveBeenCalledTimes(1);
      expect(mockFse.remove).toHaveBeenCalledTimes(1);

      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('index saved to GCS'),
      );
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('object saved to GCS'),
      );
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('workspace saved to GCS'),
      );
    });

    it('should throw if contextId is missing', async () => {
      const taskWithoutContext: SDKTask = { ...mockTask, contextId: '' };
      const store = new GCSTaskStore(bucketName);
      await expect(store.save(taskWithoutContext)).rejects.toThrow(
        'Task task1 is missing contextId.',
      );
    });

    it('should handle tar creation failure', async () => {
      mockFse.pathExists.mockImplementation(
        async (path) =>
          !path.toString().includes('task-task1-workspace-test-uuid.tar.gz'),
      );
      const store = new GCSTaskStore(bucketName);
      await expect(store.save(mockTask)).rejects.toThrow(
        'tar.c command failed to create',
      );
    });
  });

  describe('load', () => {
    it('should load task and workspace using the contextId index', async () => {
      const taskId = 'task1';
      const contextId = 'ctx1';
      const mockTaskObject = { id: taskId, contextId, kind: 'task' };

      // Mock file downloads
      const mockContextIdFile = {
        ...mockFile,
        download: vi.fn().mockResolvedValue([Buffer.from(contextId)]),
        exists: vi.fn().mockResolvedValue([true]),
      };
      const mockTaskFile = {
        ...mockFile,
        download: vi
          .fn()
          .mockResolvedValue([Buffer.from(JSON.stringify(mockTaskObject))]),
        exists: vi.fn().mockResolvedValue([true]),
      };
      const mockWorkspaceFile = {
        ...mockFile,
        download: vi.fn().mockResolvedValue([Buffer.from('workspace data')]),
        exists: vi.fn().mockResolvedValue([true]),
      };

      mockBucket.file.mockImplementation((path) => {
        if (path.endsWith('contextId.txt')) return mockContextIdFile;
        if (path.endsWith('task.json')) return mockTaskFile;
        if (path.endsWith('workspace.tar.gz')) return mockWorkspaceFile;
        return mockFile; // Default
      });

      const store = new GCSTaskStore(bucketName);
      const task = await store.load(taskId);

      expect(task).toEqual(mockTaskObject);

      // Verify correct paths were used
      expect(mockBucket.file).toHaveBeenCalledWith('tasks/task1/contextId.txt');
      expect(mockBucket.file).toHaveBeenCalledWith(
        'contexts/ctx1/task1/task.json',
      );
      expect(mockBucket.file).toHaveBeenCalledWith(
        'contexts/ctx1/task1/workspace.tar.gz',
      );

      // Verify workspace was extracted
      expect(mockTar.x).toHaveBeenCalledTimes(1);
      expect(mockFse.remove).toHaveBeenCalledTimes(1);
    });

    it('should return undefined if contextId index not found', async () => {
      mockFile.exists.mockResolvedValue([false]);
      const store = new GCSTaskStore(bucketName);
      const task = await store.load('task1');
      expect(task).toBeUndefined();
      expect(mockBucket.file).toHaveBeenCalledWith('tasks/task1/contextId.txt');
    });

    it('should throw if index exists but task object does not', async () => {
      const mockContextIdFile = {
        ...mockFile,
        download: vi.fn().mockResolvedValue([Buffer.from('ctx1')]),
        exists: vi.fn().mockResolvedValue([true]),
      };
      const mockTaskFile = {
        ...mockFile,
        exists: vi.fn().mockResolvedValue([false]),
      };

      mockBucket.file.mockImplementation((path) => {
        if (path.endsWith('contextId.txt')) return mockContextIdFile;
        if (path.endsWith('task.json')) return mockTaskFile;
        return mockFile;
      });

      const store = new GCSTaskStore(bucketName);
      await expect(store.load('task1')).rejects.toThrow(
        'Inconsistent state: Task object not found for task task1',
      );
    });

    it('should load task even if workspace not found', async () => {
      const taskId = 'task1';
      const contextId = 'ctx1';
      const mockTaskObject = { id: taskId, contextId, kind: 'task' };

      const mockContextIdFile = {
        ...mockFile,
        download: vi.fn().mockResolvedValue([Buffer.from(contextId)]),
        exists: vi.fn().mockResolvedValue([true]),
      };
      const mockTaskFile = {
        ...mockFile,
        download: vi
          .fn()
          .mockResolvedValue([Buffer.from(JSON.stringify(mockTaskObject))]),
        exists: vi.fn().mockResolvedValue([true]),
      };
      const mockWorkspaceFile = {
        ...mockFile,
        exists: vi.fn().mockResolvedValue([false]),
      };

      mockBucket.file.mockImplementation((path) => {
        if (path.endsWith('contextId.txt')) return mockContextIdFile;
        if (path.endsWith('task.json')) return mockTaskFile;
        if (path.endsWith('workspace.tar.gz')) return mockWorkspaceFile;
        return mockFile;
      });

      const store = new GCSTaskStore(bucketName);
      const task = await store.load(taskId);

      expect(task).toEqual(mockTaskObject);
      expect(mockTar.x).not.toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('workspace archive not found'),
      );
    });
  });
});

describe('NoOpTaskStore', () => {
  let realStore: TaskStore;
  let noOpStore: NoOpTaskStore;

  beforeEach(() => {
    // Create a mock of the real store to delegate to
    realStore = {
      save: vi.fn(),
      load: vi.fn().mockResolvedValue({ id: 'task-123' } as SDKTask),
    };
    noOpStore = new NoOpTaskStore(realStore);
  });

  it("should not call the real store's save method", async () => {
    const mockTask: SDKTask = { id: 'test-task' } as SDKTask;
    await noOpStore.save(mockTask);
    expect(realStore.save).not.toHaveBeenCalled();
  });

  it('should delegate the load method to the real store', async () => {
    const taskId = 'task-123';
    const result = await noOpStore.load(taskId);
    expect(realStore.load).toHaveBeenCalledWith(taskId);
    expect(result).toBeDefined();
    expect(result?.id).toBe(taskId);
  });
});

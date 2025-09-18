/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  vi,
  type Mock,
} from 'vitest';
import request from 'supertest';
import type express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { createApp, updateCoderAgentCardUrl } from './app.js';
import { GCSTaskStore } from '../persistence/gcs.js';

// Mock the logger to avoid polluting test output
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Mock the GCS Task Store
vi.mock('../persistence/gcs.js', () => {
  const GCSTaskStore = vi.fn();
  GCSTaskStore.prototype.getContextHistory = vi
    .fn()
    .mockResolvedValue([{ messageId: 'history-message' }]);
  return { GCSTaskStore };
});

describe('Agent Server Endpoints', () => {
  let app: express.Express;
  let server: Server;

  beforeAll(async () => {
    // Set the GCS_BUCKET_NAME env var to trigger GCSTaskStore instantiation
    process.env['GCS_BUCKET_NAME'] = 'test-bucket';
    app = await createApp();
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const port = (server.address() as AddressInfo).port;
        updateCoderAgentCardUrl(port);
        resolve();
      });
    });
  });

  afterAll(async () => {
    delete process.env['GCS_BUCKET_NAME'];
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) return reject(err);
          resolve();
        });
      });
    }
  });

  it('should return agent metadata via GET /.well-known/agent-card.json', async () => {
    const response = await request(app).get('/.well-known/agent-card.json');
    const port = (server.address() as AddressInfo).port;
    expect(response.status).toBe(200);
    expect(response.body.name).toBe('Gemini SDLC Agent');
    expect(response.body.url).toBe(`http://localhost:${port}/`);
  });

  it('should get context history via GET /contexts/:contextId/history', async () => {
    const contextId = 'test-context-id';
    const response = await request(app).get(`/contexts/${contextId}/history`);
    expect(response.status).toBe(200);
    expect(Array.isArray(response.body)).toBe(true);
    expect(response.body[0].messageId).toBe('history-message');
    // Verify our mock was called
    const mockGCSTaskStoreInstance = (GCSTaskStore as Mock).mock.instances[0];
    expect(mockGCSTaskStoreInstance.getContextHistory).toHaveBeenCalledWith(
      contextId,
    );
  });

  it('should return 501 for history endpoint if not using GCSTaskStore', async () => {
    // Temporarily unset the bucket name to force InMemoryTaskStore
    delete process.env['GCS_BUCKET_NAME'];
    const tempApp = await createApp();
    const response = await request(tempApp).get(
      '/contexts/some-context/history',
    );
    expect(response.status).toBe(501);
    // Restore for other tests
    process.env['GCS_BUCKET_NAME'] = 'test-bucket';
  });
});

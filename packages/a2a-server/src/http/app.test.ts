/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '@google/gemini-cli-core';
import {
  GeminiEventType,
  ApprovalMode,
  type ToolCallConfirmationDetails,
} from '@google/gemini-cli-core';
import type {
  TaskStatusUpdateEvent,
  SendStreamingMessageSuccessResponse,
} from '@a2a-js/sdk';
import type express from 'express';
import type { Server } from 'node:http';
import request from 'supertest';
import {
  afterAll,
  afterEach,
  beforeEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { createApp } from './app.js';
import {
  assertUniqueFinalEventIsLast,
  assertTaskCreationAndWorkingStatus,
  createStreamMessageRequest,
  createMockConfig,
} from '../utils/testing_utils.js';
import { MockTool } from '@google/gemini-cli-core';

const mockToolConfirmationFn = async () =>
  ({}) as unknown as ToolCallConfirmationDetails;

const streamToSSEEvents = (
  stream: string,
): SendStreamingMessageSuccessResponse[] =>
  stream
    .split('\n\n')
    .filter(Boolean) // Remove empty strings from trailing newlines
    .map((chunk) => {
      const dataLine = chunk
        .split('\n')
        .find((line) => line.startsWith('data: '));
      if (!dataLine) {
        throw new Error(`Invalid SSE chunk found: "${chunk}"`);
      }
      return JSON.parse(dataLine.substring(6));
    });

// Mock the logger to avoid polluting test output
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

let config: Config;
const getToolRegistrySpy = vi.fn();
const getApprovalModeSpy = vi.fn();
const getShellExecutionConfigSpy = vi.fn();
vi.mock('../config/config.js', async () => {
  const actual = await vi.importActual('../config/config.js');
  return {
    ...actual,
    loadConfig: vi.fn().mockImplementation(async () => {
      const mockConfig = createMockConfig({
        getToolRegistry: getToolRegistrySpy,
        getApprovalMode: getApprovalModeSpy,
        getShellExecutionConfig: getShellExecutionConfigSpy,
      });
      config = mockConfig as Config;
      return config;
    }),
  };
});

// Mock the GeminiClient to avoid actual API calls
const sendMessageStreamSpy = vi.fn();
vi.mock('@google/gemini-cli-core', async () => {
  const actual = await vi.importActual('@google/gemini-cli-core');
  return {
    ...actual,
    GeminiClient: vi.fn().mockImplementation(() => ({
      sendMessageStream: sendMessageStreamSpy,
      getUserTier: vi.fn().mockReturnValue('free'),
      initialize: vi.fn(),
      getHistory: vi.fn().mockReturnValue([]),
    })),
  };
});

describe('E2E Tests', () => {
  let app: express.Express;
  let server: Server;

  beforeAll(async () => {
    app = await createApp();
    server = app.listen(0); // Listen on a random available port
  });

  beforeEach(() => {
    getApprovalModeSpy.mockReturnValue(ApprovalMode.DEFAULT);
  });

  afterAll(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  );

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should create a new task and stream status updates (text-content) via POST /', async () => {
    sendMessageStreamSpy.mockImplementation(async function* () {
      await new Promise((resolve) => setTimeout(resolve, 1));
      yield* [{ type: GeminiEventType.Content, value: 'Hello how are you?' }];
    });

    const agent = request.agent(app);
    const res = await agent
      .post('/')
      .send(createStreamMessageRequest('hello', 'a2a-test-message'))
      .set('Content-Type', 'application/json')
      .expect(200);

    const events = streamToSSEEvents(res.text);

    assertTaskCreationAndWorkingStatus(events);

    // Status update: text-content
    const textContentEvent = events[2].result as TaskStatusUpdateEvent;
    expect(textContentEvent.kind).toBe('status-update');
    expect(textContentEvent.status.state).toBe('working');
    expect(textContentEvent.metadata?.['coderAgent']).toMatchObject({
      kind: 'text-content',
    });
    expect(textContentEvent.status.message?.parts).toMatchObject([
      { kind: 'text', text: 'Hello how are you?' },
    ]);

    assertUniqueFinalEventIsLast(events);
    expect(events.length).toBe(4);
  });

  it('should create a new task, schedule a tool call, and wait for approval', async () => {
    sendMessageStreamSpy.mockImplementationOnce(async function* () {
      yield* [
        {
          type: GeminiEventType.ToolCallRequest,
          value: {
            callId: 'test-call-id',
            name: 'test-tool',
            args: {},
          },
        },
      ];
    });
    sendMessageStreamSpy.mockImplementation(async function* () {});

    const mockTool = new MockTool({
      name: 'test-tool',
      shouldConfirmExecute: vi.fn(mockToolConfirmationFn),
    });

    getToolRegistrySpy.mockReturnValue({
      getAllTools: vi.fn().mockReturnValue([mockTool]),
      getToolsByServer: vi.fn().mockReturnValue([]),
      getTool: vi.fn().mockReturnValue(mockTool),
    });

    const agent = request.agent(app);
    const res = await agent
      .post('/')
      .send(createStreamMessageRequest('run a tool', 'a2a-tool-test-message'))
      .set('Content-Type', 'application/json')
      .expect(200);

    const events = streamToSSEEvents(res.text);
    assertTaskCreationAndWorkingStatus(events);

    const toolCallUpdateEvent = events[3].result as TaskStatusUpdateEvent;
    expect(toolCallUpdateEvent.metadata?.['coderAgent']).toMatchObject({
      kind: 'tool-call-update',
    });

    const toolCallConfirmationEvent = events[4].result as TaskStatusUpdateEvent;
    expect(toolCallConfirmationEvent.metadata?.['coderAgent']).toMatchObject({
      kind: 'tool-call-confirmation',
    });

    assertUniqueFinalEventIsLast(events);
  });
});

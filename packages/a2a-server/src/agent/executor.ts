/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Message, Task as SDKTask } from '@a2a-js/sdk';
import type {
  TaskStore,
  AgentExecutor,
  AgentExecutionEvent,
  RequestContext,
  ExecutionEventBus,
} from '@a2a-js/sdk/server';
import type {
  ToolCallRequestInfo,
  ServerGeminiToolCallRequestEvent,
  Config,
} from '@google/gemini-cli-core';
import { GeminiEventType } from '@google/gemini-cli-core';
import { v4 as uuidv4 } from 'uuid';

import { logger } from '../utils/logger.js';
import type { StateChange, AgentSettings } from '../types.js';
import { CoderAgentEvent, getPersistedState } from '../types.js';
import { loadConfig, loadEnvironment, setTargetDir } from '../config/config.js';
import { loadSettings } from '../config/settings.js';
import { loadExtensions } from '../config/extension.js';
import { Task } from './task.js';
import { requestStorage } from '../http/requestStorage.js';
import { pushTaskStateFailed } from '../utils/executor_utils.js';

/**
 * CoderAgentExecutor implements the agent's core logic for code generation.
 */
export class CoderAgentExecutor implements AgentExecutor {
  private tasks: Map<string, Task> = new Map();
  // Track tasks with an active execution loop.
  private executingTasks = new Set<string>();

  constructor(private taskStore?: TaskStore) {}

  private async getConfig(
    agentSettings: AgentSettings,
    taskId: string,
  ): Promise<Config> {
    const workspaceRoot = setTargetDir(agentSettings);
    loadEnvironment(); // Will override any global env with workspace envs
    const settings = loadSettings(workspaceRoot);
    const extensions = loadExtensions(workspaceRoot);
    return await loadConfig(settings, extensions, taskId);
  }

  private toSDKTask(task: Task): SDKTask {
    const sdkTask: SDKTask = {
      id: task.id,
      contextId: task.contextId,
      kind: 'task',
      status: {
        state: task.taskState,
        timestamp: new Date().toISOString(),
      },
      metadata: {
        __persistedState: {
          _agentSettings: task.agentSettings,
          _taskState: task.taskState,
        },
      },
      history: task.getHistory(),
      artifacts: [], // TODO: Populate artifacts
    };
    return sdkTask;
  }

  /**
   * Reconstructs a Task from an SDKTask.
   */
  async reconstruct(
    sdkTask: SDKTask,
    eventBus?: ExecutionEventBus,
  ): Promise<Task> {
    const persistedState = getPersistedState(sdkTask.metadata || {});

    if (!persistedState) {
      throw new Error(
        `Cannot reconstruct task ${sdkTask.id}: missing persisted state in metadata.`,
      );
    }

    const agentSettings = persistedState._agentSettings;
    const config = await this.getConfig(agentSettings, sdkTask.id);

    const runtimeTask = await Task.create(
      sdkTask.id,
      sdkTask.contextId,
      config,
      agentSettings,
      eventBus,
    );
    runtimeTask.taskState = persistedState._taskState;
    await runtimeTask.geminiClient.initialize();
    if (sdkTask.history) {
      for (const message of sdkTask.history) {
        runtimeTask.geminiClient.addHistory({
          role: message.role === 'agent' ? 'model' : 'user',
          parts: message.parts.map((part) => ({
            text: (part as { text: string }).text,
          })),
        });
      }
    }

    this.tasks.set(sdkTask.id, runtimeTask);
    logger.info(`Task ${sdkTask.id} reconstructed from store.`);
    return runtimeTask;
  }

  async createTask(
    taskId: string,
    contextId: string,
    agentSettings: AgentSettings,
    eventBus?: ExecutionEventBus,
  ): Promise<Task> {
    const config = await this.getConfig(agentSettings, taskId);
    const runtimeTask = await Task.create(
      taskId,
      contextId,
      config,
      agentSettings,
      eventBus,
    );
    await runtimeTask.geminiClient.initialize();

    this.tasks.set(taskId, runtimeTask);
    if (this.taskStore) {
      await this.taskStore.save(this.toSDKTask(runtimeTask));
    }
    logger.info(`New task ${taskId} created.`);
    return runtimeTask;
  }

  getTask(taskId: string): Task | undefined {
    return this.tasks.get(taskId);
  }

  getAllTasks(): Task[] {
    return Array.from(this.tasks.values());
  }

  cancelTask = async (
    taskId: string,
    eventBus: ExecutionEventBus,
  ): Promise<void> => {
    logger.info(
      `[CoderAgentExecutor] Received cancel request for task ${taskId}`,
    );
    const task = this.tasks.get(taskId);

    if (!task) {
      logger.warn(
        `[CoderAgentExecutor] Task ${taskId} not found for cancellation.`,
      );
      eventBus.publish({
        kind: 'status-update',
        taskId,
        contextId: uuidv4(),
        status: {
          state: 'failed',
          message: {
            kind: 'message',
            role: 'agent',
            parts: [{ kind: 'text', text: `Task ${taskId} not found.` }],
            messageId: uuidv4(),
            taskId,
          },
        },
        final: true,
      });
      return;
    }

    if (task.taskState === 'canceled' || task.taskState === 'failed') {
      logger.info(
        `[CoderAgentExecutor] Task ${taskId} is already in a final state: ${task.taskState}. No action needed for cancellation.`,
      );
      eventBus.publish({
        kind: 'status-update',
        taskId,
        contextId: task.contextId,
        status: {
          state: task.taskState,
          message: {
            kind: 'message',
            role: 'agent',
            parts: [
              {
                kind: 'text',
                text: `Task ${taskId} is already ${task.taskState}.`,
              },
            ],
            messageId: uuidv4(),
            taskId,
          },
        },
        final: true,
      });
      return;
    }

    try {
      logger.info(
        `[CoderAgentExecutor] Initiating cancellation for task ${taskId}.`,
      );
      task.cancelPendingTools('Task canceled by user request.');

      const stateChange: StateChange = {
        kind: CoderAgentEvent.StateChangeEvent,
      };
      task.setTaskStateAndPublishUpdate(
        'canceled',
        stateChange,
        'Task canceled by user request.',
        undefined,
        true,
      );
      logger.info(
        `[CoderAgentExecutor] Task ${taskId} cancellation processed. Saving state.`,
      );

      if (this.taskStore) {
        await this.taskStore.save(this.toSDKTask(task));
        logger.info(
          `[CoderAgentExecutor] Task ${taskId} state CANCELED saved.`,
        );
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      logger.error(
        `[CoderAgentExecutor] Error during task cancellation for ${taskId}: ${errorMessage}`,
        error,
      );
      eventBus.publish({
        kind: 'status-update',
        taskId,
        contextId: task.contextId,
        status: {
          state: 'failed',
          message: {
            kind: 'message',
            role: 'agent',
            parts: [
              {
                kind: 'text',
                text: `Failed to process cancellation for task ${taskId}: ${errorMessage}`,
              },
            ],
            messageId: uuidv4(),
            taskId,
          },
        },
        final: true,
      });
    }
  };

  async execute(
    requestContext: RequestContext,
    eventBus: ExecutionEventBus,
  ): Promise<void> {
    const userMessage = requestContext.userMessage as Message;
    const sdkTask = requestContext.task as SDKTask | undefined;

    const taskId = sdkTask?.id || userMessage.taskId || uuidv4();
    const contextId: string =
      userMessage.contextId || sdkTask?.contextId || uuidv4();

    logger.info(
      `[CoderAgentExecutor] Executing for taskId: ${taskId}, contextId: ${contextId}`,
    );
    logger.info(
      `[CoderAgentExecutor] userMessage: ${JSON.stringify(userMessage)}`,
    );
    eventBus.on('event', (event: AgentExecutionEvent) =>
      logger.info('[EventBus event]: ', event),
    );

    const store = requestStorage.getStore();
    if (!store) {
      logger.error(
        '[CoderAgentExecutor] Could not get request from async local storage. Cancellation on socket close will not be handled for this request.',
      );
    }

    const abortController = new AbortController();
    const abortSignal = abortController.signal;

    if (store) {
      const socket = store.req.socket;
      const onClientEnd = () => {
        logger.info(
          `[CoderAgentExecutor] Client socket closed for task ${taskId}. Cancelling execution.`,
        );
        if (!abortController.signal.aborted) {
          abortController.abort();
        }
        socket.removeListener('close', onClientEnd);
      };
      socket.on('close', onClientEnd);
      abortSignal.addEventListener('abort', () => {
        socket.removeListener('close', onClientEnd);
      });
      logger.info(
        `[CoderAgentExecutor] Socket close handler set up for task ${taskId}.`,
      );
    }

    let currentTask: Task | undefined = this.tasks.get(taskId);

    if (currentTask) {
      currentTask.eventBus = eventBus;
      logger.info(`[CoderAgentExecutor] Task ${taskId} found in memory cache.`);
    } else if (sdkTask) {
      logger.info(
        `[CoderAgentExecutor] Task ${taskId} found in TaskStore. Reconstructing...`,
      );
      try {
        currentTask = await this.reconstruct(sdkTask, eventBus);
      } catch (e) {
        logger.error(
          `[CoderAgentExecutor] Failed to hydrate task ${taskId}:`,
          e,
        );
        pushTaskStateFailed(e, eventBus, taskId, sdkTask.contextId);
        return;
      }
    } else {
      const agentSettings = (userMessage.metadata as any)
        ?.coderAgent as AgentSettings;
      if (
        !agentSettings ||
        agentSettings.kind !== CoderAgentEvent.StateAgentSettingsEvent
      ) {
        logger.error(
          `[CoderAgentExecutor] AgentSettings are missing from the first message for task ${taskId}.`,
        );
        pushTaskStateFailed(
          new Error(
            'Internal error: AgentSettings not found in the first message of a new task.',
          ),
          eventBus,
          taskId,
          contextId,
        );
        return;
      }
      currentTask = await this.createTask(
        taskId,
        contextId,
        agentSettings,
        eventBus,
      );
    }

    if (!currentTask) {
      logger.error(
        `[CoderAgentExecutor] Task ${taskId} is unexpectedly undefined after load/create.`,
      );
      return;
    }

    if (['canceled', 'failed', 'completed'].includes(currentTask.taskState)) {
      logger.warn(
        `[CoderAgentExecutor] Attempted to execute task ${taskId} which is already in state ${currentTask.taskState}. Ignoring.`,
      );
      return;
    }

    if (this.executingTasks.has(taskId)) {
      logger.info(
        `[CoderAgentExecutor] Task ${taskId} has a pending execution. Processing message and yielding.`,
      );
      currentTask.eventBus = eventBus;
      for await (const _ of currentTask.acceptUserMessage(
        requestContext,
        abortController.signal,
      )) {
        // Process message
      }
      return;
    }

    logger.info(
      `[CoderAgentExecutor] Starting main execution for message ${userMessage.messageId} for task ${taskId}.`,
    );
    this.executingTasks.add(taskId);

    try {
      let agentTurnActive = true;
      let agentEvents = currentTask.acceptUserMessage(
        requestContext,
        abortSignal,
      );

      while (agentTurnActive) {
        const toolCallRequests: ToolCallRequestInfo[] = [];
        for await (const event of agentEvents) {
          if (abortSignal.aborted) throw new Error('Execution aborted');
          if (event.type === GeminiEventType.ToolCallRequest) {
            toolCallRequests.push(
              (event as ServerGeminiToolCallRequestEvent).value,
            );
            continue;
          }
          await currentTask.acceptAgentMessage(event);
        }

        if (abortSignal.aborted) throw new Error('Execution aborted');

        if (toolCallRequests.length > 0) {
          await currentTask.scheduleToolCalls(toolCallRequests, abortSignal);
        }

        await currentTask.waitForPendingTools();
        if (abortSignal.aborted) throw new Error('Execution aborted');

        const completedTools = currentTask.getAndClearCompletedTools();

        if (completedTools.length > 0) {
          if (completedTools.every((tool) => tool.status === 'cancelled')) {
            currentTask.addToolResponsesToHistory(completedTools);
            agentTurnActive = false;
            currentTask.setTaskStateAndPublishUpdate(
              'input-required',
              { kind: CoderAgentEvent.StateChangeEvent },
              undefined,
              undefined,
              true,
            );
          } else {
            agentEvents = currentTask.sendCompletedToolsToLlm(
              completedTools,
              abortSignal,
            );
          }
        } else {
          agentTurnActive = false;
        }
      }

      currentTask.setTaskStateAndPublishUpdate(
        'input-required',
        { kind: CoderAgentEvent.StateChangeEvent },
        undefined,
        undefined,
        true,
      );
    } catch (error) {
      if (abortSignal.aborted) {
        logger.warn(`[CoderAgentExecutor] Task ${taskId} execution aborted.`);
        currentTask.cancelPendingTools('Execution aborted');
        if (
          currentTask.taskState !== 'canceled' &&
          currentTask.taskState !== 'failed'
        ) {
          currentTask.setTaskStateAndPublishUpdate(
            'input-required',
            { kind: CoderAgentEvent.StateChangeEvent },
            'Execution aborted by client.',
            undefined,
            true,
          );
        }
      } else {
        const errorMessage =
          error instanceof Error ? error.message : 'Agent execution error';
        logger.error(
          `[CoderAgentExecutor] Error executing agent for task ${taskId}:`,
          error,
        );
        currentTask.cancelPendingTools(errorMessage);
        if (currentTask.taskState !== 'failed') {
          currentTask.setTaskStateAndPublishUpdate(
            'failed',
            { kind: CoderAgentEvent.StateChangeEvent },
            errorMessage,
            undefined,
            true,
          );
        }
      }
    } finally {
      this.executingTasks.delete(taskId);
      logger.info(
        `[CoderAgentExecutor] Execution finished for task ${taskId}. State will be saved by the handler.`,
      );
    }
  }
}

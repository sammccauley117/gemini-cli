#!/usr/bin/env node

import readline from 'node:readline';
import crypto from 'node:crypto';

import type {
  // Specific Params/Payload types used by the CLI
  MessageSendParams, // Changed from TaskSendParams
  TaskStatusUpdateEvent,
  TaskArtifactUpdateEvent,
  Message,
  Task, // Added for direct Task events
  // Other types needed for message/part handling
  FilePart,
  DataPart,
  // Type for the agent card
  AgentCard,
  Part, // Added for explicit Part typing
} from '@a2a-js/sdk';

import { A2AClient } from '@a2a-js/sdk/client';

// --- ANSI Colors ---
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
};

// --- Helper Functions ---
function colorize(color: keyof typeof colors, text: string): string {
  return `${colors[color]}${text}${colors.reset}`;
}

function generateId(): string {
  // Renamed for more general use
  return crypto.randomUUID();
}

// --- State ---
let currentTaskId: string | null = null;
let currentContextId: string | null = null;
const serverUrl = process.argv[2] || 'http://localhost:41242'; // Agent's base URL
const client = new A2AClient(serverUrl);
let agentName = 'Agent'; // Default, try to get from agent card later

// --- Readline Setup ---
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: colorize('cyan', 'User: '),
});

function updatePrompt() {
  rl.setPrompt(
    colorize(
      'cyan',
      `User (context: ${currentContextId ? currentContextId : 'none'}, task: ${currentTaskId ? currentTaskId : 'none'}): `,
    ),
  );
}

// --- Response Handling ---
// Function now accepts the unwrapped event payload directly
function printAgentEvent(
  event: TaskStatusUpdateEvent | TaskArtifactUpdateEvent,
) {
  const timestamp = new Date().toLocaleTimeString();
  const prefix = colorize('magenta', `\n${agentName} [${timestamp}]:`);

  // Check if it's a TaskStatusUpdateEvent
  if (event.kind === 'status-update') {
    const update = event as TaskStatusUpdateEvent; // Cast for type safety
    const state = update.status.state;
    let stateEmoji = '❓';
    let stateColor: keyof typeof colors = 'yellow';

    switch (state) {
      case 'working':
        stateEmoji = '⏳';
        stateColor = 'blue';
        break;
      case 'input-required':
        stateEmoji = '🤔';
        stateColor = 'yellow';
        break;
      case 'completed':
        stateEmoji = '✅';
        stateColor = 'green';
        break;
      case 'canceled':
        stateEmoji = '⏹️';
        stateColor = 'gray';
        break;
      case 'failed':
        stateEmoji = '❌';
        stateColor = 'red';
        break;
      default:
        stateEmoji = 'ℹ️'; // For other states like submitted, rejected etc.
        stateColor = 'dim';
        break;
    }

    console.log(
      `${prefix} ${stateEmoji} Status: ${colorize(
        stateColor,
        state,
      )} (Task: ${update.taskId}, Context: ${update.contextId}) ${
        update.final ? colorize('bright', '[FINAL]') : ''
      }`,
    );

    if (update.status.message) {
      printMessageContent(update.status.message);
    }
  }
  // Check if it's a TaskArtifactUpdateEvent
  else if (event.kind === 'artifact-update') {
    const update = event as TaskArtifactUpdateEvent; // Cast for type safety
    console.log(
      `${prefix} 📄 Artifact Received: ${
        update.artifact.name || '(unnamed)'
      } (ID: ${update.artifact.artifactId}, Task: ${update.taskId}, Context: ${
        update.contextId
      })`,
    );
    // Create a temporary message-like structure to reuse printMessageContent
    printMessageContent({
      messageId: generateId(), // Dummy messageId
      kind: 'message', // Dummy kind
      role: 'agent', // Assuming artifact parts are from agent
      parts: update.artifact.parts,
      taskId: update.taskId,
      contextId: update.contextId,
    });
  } else {
    // This case should ideally not be reached if called correctly
    console.log(
      prefix,
      colorize('yellow', 'Received unknown event type in printAgentEvent:'),
      event,
    );
  }
}

function printMessageContent(message: Message) {
  message.parts.forEach((part: Part, index: number) => {
    // Added explicit Part type
    const partPrefix = colorize('red', `  Part ${index + 1}:`);
    if (part.kind === 'text') {
      // Check kind property
      console.log(`${partPrefix} ${colorize('green', '📝 Text:')}`, part.text);
    } else if (part.kind === 'file') {
      // Check kind property
      const filePart = part as FilePart;
      console.log(
        `${partPrefix} ${colorize('blue', '📄 File:')} Name: ${
          filePart.file.name || 'N/A'
        }, Type: ${filePart.file.mimeType || 'N/A'}, Source: ${
          'bytes' in filePart.file ? 'Inline (bytes)' : filePart.file.uri
        }`,
      );
    } else if (part.kind === 'data') {
      // Check kind property
      const dataPart = part as DataPart;
      console.log(
        `${partPrefix} ${colorize('yellow', '📊 Data:')}`,
        JSON.stringify(dataPart.data, null, 2),
      );
    } else {
      console.log(
        `${partPrefix} ${colorize('yellow', 'Unsupported part kind:')}`,
        part,
      );
    }
  });
}

// --- Agent Card Fetching ---
async function fetchAndDisplayAgentCard() {
  // Use the client's getAgentCard method.
  // The client was initialized with serverUrl, which is the agent's base URL.
  console.log(
    colorize(
      'dim',
      `Attempting to fetch agent card from agent at: ${serverUrl}`,
    ),
  );
  try {
    // client.getAgentCard() uses the agentBaseUrl provided during client construction
    const card: AgentCard = await client.getAgentCard();
    agentName = card.name || 'Agent'; // Update global agent name
    console.log(colorize('green', `✓ Agent Card Found:`));
    console.log(`  Name:        ${colorize('bright', agentName)}`);
    if (card.description) {
      console.log(`  Description: ${card.description}`);
    }
    console.log(`  Version:     ${card.version || 'N/A'}`);
    if (card.capabilities?.streaming) {
      console.log(`  Streaming:   ${colorize('green', 'Supported')}`);
    } else {
      console.log(
        `  Streaming:   ${colorize(
          'yellow',
          'Not Supported (or not specified)',
        )}`,
      );
    }
    // Update prompt prefix to use the fetched name
    // The prompt is set dynamically before each rl.prompt() call in the main loop
    // to reflect the current agentName if it changes (though unlikely after initial fetch).
  } catch (error: any) {
    console.log(colorize('yellow', `⚠️ Error fetching or parsing agent card`));
    throw error;
  }
}

// --- Command Handlers ---
// --- Command Handlers ---
async function resumeLastTaskInContext() {
  if (!currentContextId) {
    return;
  }

  try {
    console.log(
      colorize(
        'dim',
        `Checking for in-flight tasks in context: ${currentContextId}`,
      ),
    );
    const historyUrl = `${serverUrl}/contexts/${currentContextId}/history`;
    const response = await fetch(historyUrl);
    if (!response.ok) {
      // It's okay if history is not found (e.g., new context). Don't throw error.
      if (response.status === 404) {
        console.log(colorize('dim', 'No history found for this context.'));
        currentTaskId = null;
        return;
      }
      throw new Error(
        `Failed to fetch history: ${response.status} ${response.statusText}`,
      );
    }
    const history: Message[] = await response.json();
    if (history.length === 0) {
      console.log(colorize('dim', 'No messages in history for this context.'));
      currentTaskId = null;
      return;
    }

    // Find the last message that has a taskId
    const lastMessageWithTask = [...history]
      .reverse()
      .find((msg) => msg.taskId);

    if (!lastMessageWithTask || !lastMessageWithTask.taskId) {
      console.log(colorize('dim', 'No previous tasks found in this context.'));
      currentTaskId = null;
      return;
    }

    const lastTaskId = lastMessageWithTask.taskId;
    console.log(
      colorize(
        'dim',
        `Found last task ID: ${lastTaskId}. Checking its status...`,
      ),
    );

    const taskResponse = await client.getTask({ id: lastTaskId });
    if ('error' in taskResponse) {
      throw new Error(
        `RPC Error getting task details: ${taskResponse.error.message} (Code: ${taskResponse.error.code})`,
      );
    }

    const taskDetails = taskResponse.result as Task;
    const taskStatus = taskDetails.status.state;

    if (taskStatus === 'input-required' || taskStatus === 'working') {
      currentTaskId = lastTaskId;
      console.log(
        colorize(
          'green',
          `✓ Resumed in-flight task ${currentTaskId} with status: ${taskStatus}`,
        ),
      );
    } else {
      currentTaskId = null;
      console.log(
        colorize(
          'dim',
          `Last task (${lastTaskId}) has a final status (${taskStatus}). Starting with a new task.`,
        ),
      );
    }
  } catch (error: any) {
    console.error(colorize('red', 'Error resuming task:'), error.message);
    currentTaskId = null; // Reset task id on error
  }
}

const commands: { [key: string]: (args: string[]) => Promise<void> } = {
  '/help': async () => {
    console.log(colorize('bright', 'Available Commands:'));
    console.log(
      `  ${colorize('cyan', '/new')}              - Start a new session (clears context and task IDs).`,
    );
    console.log(
      `  ${colorize('cyan', '/enter <contextId>')} - Enter an existing context and resume the last task if it was in-flight.`,
    );
    console.log(
      `  ${colorize('cyan', '/status')}            - Show the current context and task IDs.`,
    );
    console.log(
      `  ${colorize('cyan', '/history')}           - Fetch and display the history for the current context.`,
    );
    console.log(
      `  ${colorize('cyan', '/gettask [taskId]')}  - Fetch details for a specific or current task.`,
    );
    console.log(
      `  ${colorize('cyan', '/cancel')}            - Cancel the current running task.`,
    );
    console.log(
      `  ${colorize('cyan', '/resubscribe')}      - Resubscribe to the current task's event stream.`,
    );
    console.log(
      `  ${colorize('cyan', '/exit')}              - Quit the client.`,
    );
  },
  '/new': async () => {
    currentTaskId = null;
    currentContextId = null;
    console.log(
      colorize(
        'bright',
        `✨ Starting new session. Task and Context IDs are cleared.`,
      ),
    );
    updatePrompt();
  },
  '/enter': async (args: string[]) => {
    const contextId = args[0];
    if (!contextId) {
      console.log(colorize('yellow', 'Usage: /enter <contextId>'));
      return;
    }
    currentContextId = contextId;
    console.log(colorize('bright', `Entering context: ${currentContextId}`));
    await resumeLastTaskInContext();
    updatePrompt();
  },
  '/exit': async () => {
    rl.close();
  },
  '/status': async () => {
    console.log(colorize('bright', 'Current Session State:'));
    console.log(
      `  ${colorize('cyan', 'Context ID:')} ${currentContextId || 'Not set'}`,
    );
    console.log(
      `  ${colorize('cyan', 'Task ID:')}    ${currentTaskId || 'Not set'}`,
    );
  },
  '/history': async () => {
    if (!currentContextId) {
      console.log(
        colorize('yellow', 'No active context. Cannot fetch history.'),
      );
      return;
    }
    try {
      console.log(
        colorize('dim', `Fetching history for context: ${currentContextId}`),
      );
      const historyUrl = `${serverUrl}/contexts/${currentContextId}/history`;
      const response = await fetch(historyUrl);
      if (!response.ok) {
        throw new Error(
          `Failed to fetch history: ${response.status} ${response.statusText}`,
        );
      }
      const history: Message[] = await response.json();
      console.log(
        colorize('bright', `History for context ${currentContextId}:`),
      );
      if (history.length === 0) {
        console.log(colorize('dim', '  (No messages in history)'));
      }
      history.forEach((message, i) => {
        const prefix =
          message.role === 'user'
            ? colorize('cyan', `User [${i}]`)
            : colorize('magenta', `Agent [${i}]`);
        console.log(`${prefix} (ID: ${message.messageId})`);
        printMessageContent(message);
      });
    } catch (error: any) {
      console.error(colorize('red', 'Error fetching history:'), error.message);
    }
  },
  '/gettask': async (args: string[]) => {
    const taskId = args[0] || currentTaskId;
    if (!taskId) {
      console.log(colorize('yellow', 'No task ID specified or in context.'));
      return;
    }
    try {
      console.log(colorize('dim', `Fetching task: ${taskId}`));
      const response = await client.getTask({ id: taskId });
      if ('error' in response) {
        throw new Error(
          `RPC Error: ${response.error.message} (Code: ${response.error.code})`,
        );
      }
      console.log(
        colorize('green', 'Task details:'),
        JSON.stringify(response.result, null, 2),
      );
    } catch (error: any) {
      console.error(colorize('red', 'Error getting task:'), error.message);
    }
  },
  '/cancel': async () => {
    if (!currentTaskId) {
      console.log(colorize('yellow', 'No active task to cancel.'));
      return;
    }
    try {
      console.log(colorize('dim', `Cancelling task: ${currentTaskId}`));
      const response = await client.cancelTask({ id: currentTaskId });
      if ('error' in response) {
        throw new Error(
          `RPC Error: ${response.error.message} (Code: ${response.error.code})`,
        );
      }
      console.log(
        colorize('green', 'Task cancelled successfully. Final state:'),
        JSON.stringify(response.result, null, 2),
      );
      currentTaskId = null; // Task is now in a final state
    } catch (error: any) {
      console.error(colorize('red', 'Error cancelling task:'), error.message);
    }
  },
  '/resubscribe': async () => {
    if (!currentTaskId) {
      console.log(colorize('yellow', 'No active task to resubscribe to.'));
      return;
    }
    console.log(
      colorize('dim', `Resubscribing to task stream: ${currentTaskId}`),
    );
    await handleStream(client.resubscribeTask({ id: currentTaskId }));
  },
};

// --- Main Loop ---
async function handleStream(
  stream: AsyncGenerator<any, void, undefined>,
): Promise<void> {
  try {
    // Iterate over the events from the stream
    for await (const event of stream) {
      const timestamp = new Date().toLocaleTimeString(); // Get fresh timestamp for each event
      const prefix = colorize('magenta', `\n${agentName} [${timestamp}]:`);

      if (event.kind === 'status-update' || event.kind === 'artifact-update') {
        const typedEvent = event as
          | TaskStatusUpdateEvent
          | TaskArtifactUpdateEvent;
        printAgentEvent(typedEvent);

        let promptNeedsUpdate = false;
        if (typedEvent.contextId && typedEvent.contextId !== currentContextId) {
          console.log(
            colorize(
              'dim',
              `   Context ID updated to ${typedEvent.contextId} based on event.`,
            ),
          );
          currentContextId = typedEvent.contextId;
          promptNeedsUpdate = true;
        }
        if (typedEvent.taskId && typedEvent.taskId !== currentTaskId) {
          console.log(
            colorize(
              'dim',
              `   Task ID updated to ${typedEvent.taskId} based on event.`,
            ),
          );
          currentTaskId = typedEvent.taskId;
          promptNeedsUpdate = true;
        }
        if (promptNeedsUpdate) {
          updatePrompt();
        }

        // If the event is a TaskStatusUpdateEvent and it's final, reset currentTaskId
        if (
          typedEvent.kind === 'status-update' &&
          (typedEvent as TaskStatusUpdateEvent).final &&
          (typedEvent as TaskStatusUpdateEvent).status.state !==
            'input-required'
        ) {
          console.log(
            colorize(
              'yellow',
              `   Task ${typedEvent.taskId} is final. Clearing current task ID.`,
            ),
          );
          currentTaskId = null;
          updatePrompt();
        }
      } else if (event.kind === 'message') {
        const msg = event as Message;
        console.log(
          `${prefix} ${colorize('green', '✉️ Message Stream Event:')}`,
        );
        printMessageContent(msg);
        if (msg.taskId && msg.taskId !== currentTaskId) {
          console.log(
            colorize(
              'dim',
              `   Task ID context updated to ${msg.taskId} based on message event.`,
            ),
          );
          currentTaskId = msg.taskId;
          updatePrompt();
        }
        if (msg.contextId && msg.contextId !== currentContextId) {
          console.log(
            colorize(
              'dim',
              `   Context ID updated to ${msg.contextId} based on message event.`,
            ),
          );
          currentContextId = msg.contextId;
          updatePrompt();
        }
      } else if (event.kind === 'task') {
        const task = event as Task;
        console.log(
          `${prefix} ${colorize(
            'blue',
            'ℹ️ Task Stream Event:',
          )} ID: ${task.id}, Context: ${task.contextId}, Status: ${task.status.state}`,
        );
        if (task.id !== currentTaskId) {
          console.log(
            colorize(
              'dim',
              `   Task ID updated from ${currentTaskId || 'N/A'} to ${task.id}`,
            ),
          );
          currentTaskId = task.id;
          updatePrompt();
        }
        if (task.contextId && task.contextId !== currentContextId) {
          console.log(
            colorize(
              'dim',
              `   Context ID updated from ${
                currentContextId || 'N/A'
              } to ${task.contextId}`,
            ),
          );
          currentContextId = task.contextId;
          updatePrompt();
        }
        if (task.status.message) {
          console.log(colorize('gray', '   Task includes message:'));
          printMessageContent(task.status.message);
        }
        if (task.artifacts && task.artifacts.length > 0) {
          console.log(
            colorize(
              'gray',
              `   Task includes ${task.artifacts.length} artifact(s).`,
            ),
          );
        }
      } else {
        console.log(
          prefix,
          colorize('yellow', 'Received unknown event structure from stream:'),
          event,
        );
      }
    }
    console.log(
      colorize('dim', `--- End of response stream for this input ---`),
    );
  } catch (error: any) {
    const timestamp = new Date().toLocaleTimeString();
    const prefix = colorize('red', `\n${agentName} [${timestamp}] ERROR:`);
    console.error(
      prefix,
      `Error communicating with agent:`,
      error.message || error,
    );
    if (error.code) {
      console.error(colorize('gray', `   Code: ${error.code}`));
    }
    if (error.data) {
      console.error(colorize('gray', `   Data: ${JSON.stringify(error.data)}`));
    }
    if (!(error.code || error.data) && error.stack) {
      console.error(
        colorize('gray', error.stack.split('\n').slice(1, 3).join('\n')),
      );
    }
  }
}

async function main() {
  console.log(colorize('bright', `A2A Terminal Client`));
  console.log(colorize('dim', `Agent Base URL: ${serverUrl}`));

  await fetchAndDisplayAgentCard(); // Fetch the card before starting the loop

  console.log(
    colorize(
      'dim',
      `No active task or context initially. Use '/help' for commands.`,
    ),
  );

  updatePrompt();
  rl.prompt();

  rl.on('line', async (line) => {
    const input = line.trim();

    if (!input) {
      rl.prompt();
      return;
    }

    if (input.startsWith('/')) {
      const [command, ...args] = input.split(' ');
      const handler = commands[command.toLowerCase()];
      if (handler) {
        await handler(args);
      } else {
        console.log(
          colorize(
            'yellow',
            `Unknown command: ${command}. Type /help for a list of commands.`,
          ),
        );
      }
      // Commands that change state should call updatePrompt themselves.
      rl.prompt();
      return;
    }

    // Construct params for sendMessageStream
    const messageId = generateId(); // Generate a unique message ID

    const messagePayload: Message = {
      messageId: messageId,
      kind: 'message', // Required by Message interface
      role: 'user',
      parts: [
        {
          kind: 'text', // Required by TextPart interface
          text: input,
        },
      ],
    };

    // Conditionally add taskId to the message payload
    if (currentTaskId) {
      messagePayload.taskId = currentTaskId;
    }
    // Conditionally add contextId to the message payload
    if (currentContextId) {
      messagePayload.contextId = currentContextId;
    }

    // If this is the first message of a new task, add AgentSettings
    if (!currentTaskId) {
      messagePayload.metadata = {
        coderAgent: {
          kind: 'agent-settings',
          workspacePath: process.cwd(), // Default workspace for the test client
        },
      };
    }

    const params: MessageSendParams = {
      message: messagePayload,
    };

    console.log(colorize('dim', 'Sending message...'));
    await handleStream(client.sendMessageStream(params));
    updatePrompt();
    rl.prompt();
  }).on('close', () => {
    console.log(colorize('yellow', '\nExiting A2A Terminal Client. Goodbye!'));
    process.exit(0);
  });
}

// --- Start ---
main().catch((err) => {
  console.error(colorize('red', 'Unhandled error in main:'), err);
  process.exit(1);
});

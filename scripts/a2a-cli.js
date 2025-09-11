

/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import readline from 'node:readline';
import crypto from 'node:crypto';
import path from 'node:path';

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
function colorize(color, text) {
  return `${colors[color]}${text}${colors.reset}`;
}

function generateId() {
  return crypto.randomUUID();
}

// --- State ---
let currentTaskId = undefined;
let currentContextId = undefined;
let workspacePath = undefined; // NEW: To hold the workspace path for the context
const serverUrl = process.argv[2] || 'http://localhost:41242';
const client = new A2AClient(serverUrl);
let agentName = 'Agent';

// --- Readline Setup ---
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function updatePrompt() {
  const contextStr = currentContextId ? `ctx: ${currentContextId}` : 'no-ctx';
  const taskStr = currentTaskId ? `task: ${currentTaskId}` : 'no-task';
  const prompt = colorize(
    'cyan',
    `${agentName} [${contextStr}, ${taskStr}] > `,
  );
  rl.setPrompt(prompt);
}

// --- Response Handling ---
function printAgentEvent(event) {
  const timestamp = new Date().toLocaleTimeString();
  const prefix = colorize('magenta', `\n${agentName} [${timestamp}]:`);

  if (event.kind === 'status-update') {
    const update = event;
    const state = update.status.state;
    let stateEmoji = '❓';
    let stateColor = 'yellow';

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
        stateEmoji = 'ℹ️';
        stateColor = 'dim';
        break;
    }

    console.log(
      `${prefix} ${stateEmoji} Status: ${colorize(stateColor, state)} (Task: ${update.taskId}, Context: ${update.contextId}) ${update.final ? colorize('bright', '[FINAL]') : ''}`,
    );

    if (update.status.message) {
      printMessageContent(update.status.message);
    }
  } else if (event.kind === 'artifact-update') {
    const update = event;
    console.log(
      `${prefix} 📄 Artifact Received: ${update.artifact.name || '(unnamed)'}
      } (ID: ${update.artifact.artifactId}, Task: ${update.taskId}, Context: ${update.contextId})`,
    );
    printMessageContent({
      messageId: generateId(),
      kind: 'message',
      role: 'agent',
      parts: update.artifact.parts,
      taskId: update.taskId,
      contextId: update.contextId,
    });
  } else {
    console.log(
      prefix,
      colorize('yellow', 'Received unknown event type:'),
      event,
    );
  }
}

function printMessageContent(message) {
  message.parts.forEach((part, index) => {
    const partPrefix = colorize('red', `  Part ${index + 1}:`);
    if (part.kind === 'text') {
      console.log(`${partPrefix} ${colorize('green', '📝 Text:')}`, part.text);
    } else if (part.kind === 'file') {
      const filePart = part;
      console.log(
        `${partPrefix} ${colorize('blue', '📄 File:')} Name: ${filePart.file.name || 'N/A'}
        }, Type: ${filePart.file.mimeType || 'N/A'}, Source: ${
          'bytes' in filePart.file ? 'Inline (bytes)' : filePart.file.uri
        }`,
      );
    } else if (part.kind === 'data') {
      const dataPart = part;
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
  console.log(
    colorize('dim', `Attempting to fetch agent card from: ${serverUrl}`),
  );
  try {
    const card = await client.getAgentCard();
    agentName = card.name || 'Agent';
    console.log(colorize('green', `✓ Agent Card Found:`));
    console.log(`  Name:        ${colorize('bright', agentName)}`);
    console.log(`  Description: ${card.description || 'N/A'}`);
    console.log(`  Version:     ${card.version || 'N/A'}`);
  } catch (error) {
    console.log(
      colorize('red', `❌ Error fetching agent card: ${error.message}`),
    );
    throw error;
  }
}

// --- Main Loop ---
async function main() {
  console.log(colorize('bright', `A2A Debugging Client`));
  console.log(colorize('dim', `Agent URL: ${serverUrl}`));

  await fetchAndDisplayAgentCard();

  console.log(colorize('green', '\nAvailable Commands:'));
  console.log(
    colorize(
      'green',
      '  /new_context [path] - Start a new session in a workspace (defaults to CWD).',
    ),
  );
  console.log(
    colorize(
      'green',
      '  /load_context <id> [path] - Resume a session using a context ID and workspace path.',
    ),
  );
  console.log(
    colorize(
      'green',
      '  /new_task             - Start a new task within the current context.',
    ),
  );
  console.log(
    colorize(
      'green',
      '  /status               - Show current context, task, and workspace info.',
    ),
  );
  console.log(
    colorize('green', '  /exit                 - Quit the client.\n'),
  );

  updatePrompt();
  rl.prompt();

  rl.on('line', async (line) => {
    const input = line.trim();
    const parts = input.split(/\s+/);
    const command = parts[0].toLowerCase();

    if (!input) {
      rl.prompt();
      return;
    }

    // --- Command Handling ---
    if (command.startsWith('/')) {
      switch (command) {
        case '/new_context':
          currentContextId = undefined;
          currentTaskId = undefined;
          workspacePath = parts[1] ? path.resolve(parts[1]) : process.cwd();
          console.log(colorize('bright', `✨ New context session started.`));
          console.log(
            colorize('dim', `   - Workspace set to: ${workspacePath}`),
          );
          console.log(
            colorize('dim', `   - Send a message to create the first task.`),
          );
          break;
        case '/load_context':
          if (parts.length < 2) {
            console.log(
              colorize(
                'red',
                'Usage: /load_context <contextId> [workspace_path]',
              ),
            );
            break;
          }
          currentContextId = parts[1];
          currentTaskId = undefined;
          workspacePath = parts[2] ? path.resolve(parts[2]) : process.cwd();
          console.log(
            colorize('bright', `🔄 Resuming context ${currentContextId}`),
          );
          console.log(
            colorize('dim', `   - Workspace set to: ${workspacePath}`),
          );
          break;
        case '/new_task':
          currentTaskId = undefined;
          console.log(
            colorize(
              'bright',
              `✨ Starting new task within context ${currentContextId || 'N/A'}.`,
            ),
          );
          break;
        case '/status':
          console.log(colorize('bright', 'Current Status:'));
          console.log(`  - Context ID:   ${currentContextId || 'Not set'}`);
          console.log(`  - Task ID:      ${currentTaskId || 'Not set'}`);
          console.log(`  - Workspace:    ${workspacePath || 'Not set'}`);
          break;
        case '/exit':
          rl.close();
          return;
        default:
          console.log(colorize('red', `Unknown command: ${command}`));
          break;
      }
      updatePrompt();
      rl.prompt();
      return;
    }

    // --- Message Sending ---
    if (!workspacePath) {
      console.log(
        colorize(
          'red',
          'No workspace path set. Please start with /new_context or /load_context.',
        ),
      );
      rl.prompt();
      return;
    }

    const messagePayload = {
      messageId: generateId(),
      kind: 'message',
      role: 'user',
      parts: [{ kind: 'text', text: input }],
    };

    // Add IDs if they exist
    if (currentTaskId) messagePayload.taskId = currentTaskId;
    if (currentContextId) messagePayload.contextId = currentContextId;

    const params = { message: messagePayload, metadata: {} };

    // Add agentSettings metadata ONLY on the first message of a context
    if (!currentContextId) {
      params.metadata = {
        coderAgent: {
          kind: 'agent-settings',
          workspacePath: workspacePath,
        },
      };
    }

    try {
      const stream = client.sendMessageStream(params);

      for await (const event of stream) {
        if (event.kind === 'task') {
          if (event.id !== currentTaskId) {
            console.log(colorize('dim', `\n   Task ID updated to ${event.id}`));
            currentTaskId = event.id;
          }
          if (event.contextId && event.contextId !== currentContextId) {
            console.log(
              colorize('dim', `   Context ID updated to ${event.contextId}`),
            );
            currentContextId = event.contextId;
          }
        }
        printAgentEvent(event);
      }
    } catch (error) {
      const timestamp = new Date().toLocaleTimeString();
      const prefix = colorize('red', `\n${agentName} [${timestamp}] ERROR:`);
      console.error(prefix, `Error:`, error.message || error);
    } finally {
      updatePrompt();
      rl.prompt();
    }
  }).on('close', () => {
    console.log(colorize('yellow', '\nExiting. Goodbye!'));
    process.exit(0);
  });
}

main().catch((err) => {
  console.error(colorize('red', 'FATAL ERROR:'), err);
  process.exit(1);
});

import * as readline from 'node:readline';
import { Agent } from './agent.js';
import { MemoryStore } from './memory.js';
import { printHelp, printInfo, printError } from './output.js';
import type { ToolOptions } from './tools/index.js';
import type { BernardConfig } from './config.js';

export function startRepl(config: BernardConfig): void {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const memoryStore = new MemoryStore();

  const confirmFn = (command: string): Promise<boolean> => {
    return new Promise((resolve) => {
      rl.question(`\x1b[33m  ⚠ Dangerous command: ${command}\n  Allow? (y/N): \x1b[0m`, (answer) => {
        resolve(answer.trim().toLowerCase() === 'y');
      });
    });
  };

  const toolOptions: ToolOptions = {
    shellTimeout: config.shellTimeout,
    confirmDangerous: confirmFn,
  };

  const agent = new Agent(config, toolOptions, memoryStore);

  const prompt = () => {
    rl.question('\x1b[36mbernard>\x1b[0m ', async (input) => {
      const trimmed = input.trim();

      if (!trimmed) {
        prompt();
        return;
      }

      if (trimmed === 'exit' || trimmed === 'quit' || trimmed === '/exit') {
        printInfo('Goodbye!');
        rl.close();
        process.exit(0);
      }

      if (trimmed === '/help') {
        printHelp();
        prompt();
        return;
      }

      if (trimmed === '/clear') {
        agent.clearHistory();
        printInfo('Conversation history and scratch notes cleared.');
        prompt();
        return;
      }

      if (trimmed === '/memory') {
        const keys = memoryStore.listMemory();
        if (keys.length === 0) {
          printInfo('No persistent memories stored.');
        } else {
          printInfo('Persistent memories:');
          for (const key of keys) {
            printInfo(`  - ${key}`);
          }
        }
        prompt();
        return;
      }

      if (trimmed === '/scratch') {
        const keys = memoryStore.listScratch();
        if (keys.length === 0) {
          printInfo('No scratch notes in this session.');
        } else {
          printInfo('Scratch notes:');
          for (const key of keys) {
            printInfo(`  - ${key}`);
          }
        }
        prompt();
        return;
      }

      try {
        await agent.processInput(trimmed);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        printError(message);
      }

      console.log(); // blank line between turns
      prompt();
    });
  };

  // Handle Ctrl+C gracefully
  rl.on('close', () => {
    printInfo('\nGoodbye!');
    process.exit(0);
  });

  prompt();
}

import chalk from 'chalk';

const MAX_TOOL_OUTPUT_LENGTH = 2000;

export function printWelcome(provider: string, model: string): void {
  console.log(chalk.bold.cyan('\n  Bernard') + chalk.gray(' — AI CLI Assistant'));
  console.log(chalk.gray(`  Provider: ${provider} | Model: ${model}`));
  console.log(chalk.gray('  Type /help for commands, exit to quit\n'));
}

export function printAssistantText(text: string): void {
  if (text.trim()) {
    console.log(chalk.white(text));
  }
}

export function printToolCall(toolName: string, args: Record<string, unknown>): void {
  const argsStr = toolName === 'shell'
    ? String(args.command || '')
    : JSON.stringify(args);
  console.log(chalk.yellow(`  ▶ ${toolName}`) + chalk.gray(`: ${argsStr}`));
}

export function printToolResult(toolName: string, result: unknown): void {
  let output: string;
  if (typeof result === 'string') {
    output = result;
  } else if (result && typeof result === 'object' && 'output' in result) {
    output = String((result as { output: string }).output);
  } else {
    output = JSON.stringify(result, null, 2);
  }

  if (output.length > MAX_TOOL_OUTPUT_LENGTH) {
    output = output.slice(0, MAX_TOOL_OUTPUT_LENGTH) + chalk.gray('\n  ... (truncated)');
  }

  const lines = output.split('\n').map(line => chalk.gray(`  ${line}`)).join('\n');
  console.log(lines);
}

export function printError(message: string): void {
  console.error(chalk.red(`Error: ${message}`));
}

export function printInfo(message: string): void {
  console.log(chalk.gray(message));
}

export function printHelp(): void {
  console.log(chalk.cyan('\nCommands:'));
  console.log(chalk.white('  /help') + chalk.gray('   — Show this help'));
  console.log(chalk.white('  /clear') + chalk.gray('  — Clear conversation history'));
  console.log(chalk.white('  exit') + chalk.gray('    — Quit Bernard'));
  console.log();
}

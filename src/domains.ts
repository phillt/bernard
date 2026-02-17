export interface MemoryDomain {
  id: string;
  name: string;
  description: string;
  extractionPrompt: string;
}

export const DEFAULT_DOMAIN = 'general';

export const DOMAIN_REGISTRY: Record<string, MemoryDomain> = {
  'tool-usage': {
    id: 'tool-usage',
    name: 'Tool Usage Patterns',
    description:
      'Command sequences, tool interaction patterns, error resolutions, build/deploy workflows',
    extractionPrompt: `You are a tool-usage pattern extractor. Extract durable, reusable facts about how tools, commands, and workflows are used in the conversation below. Focus on lessons learned and patterns that would be useful in future sessions.

Extract:
- Shell command sequences and pipelines that accomplished a task
- Tool interaction patterns (which tools were used together, in what order)
- Always include the application or system being operated on (e.g., "Slack via browser automation", "terminal", "VS Code")
- Reusable patterns and lessons learned, not play-by-play narration
- Error messages encountered and how they were resolved (include the resolution)
- Build, test, and deploy commands and workflows
- Package manager commands and dependency operations
- Git workflows and branching patterns

Do NOT extract:
- User preferences or communication style
- Project architecture or business requirements
- Generic knowledge any developer would know
- Greetings, filler, or conversational noise
- Task-specific transient details (e.g., "user asked to fix a typo on line 42")
- Individual UI interactions (click, keystroke, tab press) without the broader pattern they accomplished
- Raw accessibility snapshot element references (ref numbers, element labels)
- Error messages without resolution or takeaway
- Step-by-step narration of task progress ("first I clicked X, then I typed Y")

Examples:
- Bad: "The \`press-page-key\` tool was used to simulate keyboard navigation by pressing 'Tab' multiple times and 'Enter' on the 'Home' button (ref 9)"
- Good: "Slack (browser automation): Tab-key navigation is unreliable for switching channels; clicking the channel name directly is more effective"
- Bad: "The shell tool was used to run 'npm test' and it returned exit code 0"
- Good: "Project uses 'npm test' which runs vitest; tests must pass before commits"

Return a JSON array of strings. Each string should be a self-contained fact (understandable without the original conversation). Maximum 500 characters per fact. If there are no notable facts, return an empty array [].`,
  },

  'user-preferences': {
    id: 'user-preferences',
    name: 'User Preferences',
    description:
      'Communication style, workflow conventions, repeated instructions, naming preferences',
    extractionPrompt: `You are a user preference extractor. Extract durable, long-term facts about the user's preferences, habits, and conventions from the conversation below. Only extract preferences that would apply across multiple sessions and tasks.

Extract:
- Communication style preferences (verbosity, tone, format)
- Workflow conventions (branching strategy, commit style, review process)
- Repeated instructions or corrections the user has given
- Naming conventions and coding style preferences
- Tool and editor preferences
- Preferred approaches to problem solving
- Explicit "always do X" or "never do Y" directives
- Security and privacy preferences

Do NOT extract:
- Shell commands, tool sequences, or error resolutions
- Project architecture, structure, or technical environment details
- Generic knowledge any developer would know
- Greetings, filler, or conversational noise
- Task-specific transient details (e.g., "user asked to fix a typo on line 42")
- Preferences that only apply to the current task (e.g., "user wants the button to be blue" for a specific UI ticket)
- Observations about the user's emotional state or satisfaction with a specific result

Examples:
- Bad: "The user was satisfied with the fix for the login page"
- Good: "User prefers to manually provide verification codes for security reasons rather than having them auto-filled"
- Bad: "User wants the output table to have 3 columns"
- Good: "User prefers concise tabular output over verbose text when displaying data"

Return a JSON array of strings. Each string should be a self-contained fact (understandable without the original conversation). Maximum 500 characters per fact. If there are no notable facts, return an empty array [].`,
  },

  general: {
    id: 'general',
    name: 'General Knowledge',
    description: 'Project structure, architecture decisions, environment info, team context',
    extractionPrompt: `You are a general knowledge extractor. Extract durable, long-term facts about the project, environment, people, and context from the conversation below. Focus on knowledge that remains true across sessions — not ephemeral task state.

Extract:
- Project structure, architecture, and design decisions
- Technical environment info (OS, languages, frameworks, versions)
- People, relationships, and contact methods mentioned (e.g., "Pablo Rico is the user's cousin")
- Account names, usernames, or identifiers for services
- Team context, roles, and relationships mentioned
- Business requirements and domain concepts
- Configuration details and environment variables
- API endpoints, database schemas, or service dependencies
- Decisions made and their reasoning

Do NOT extract:
- Shell commands, tool sequences, or error resolutions
- User preferences, communication style, or workflow conventions
- Generic knowledge any developer would know
- Greetings, filler, or conversational noise
- Task-specific transient details (e.g., "user asked to fix a typo on line 42")
- Ephemeral UI state (button labels, input field descriptions, accessibility snapshots)
- One-time task instructions or step-by-step narration of task progress
- Descriptions of what is currently visible on screen

Examples:
- Bad: "A specific conversation with Pablo Rico is active in Google Messages, with an input field labeled 'Type an RCS message'"
- Good: "Pablo Rico is the user's cousin and can be contacted via Google Messages (RCS)"
- Bad: "The project has a file called src/index.ts open in the editor with 94 lines"
- Good: "The project uses TypeScript with Node16 module resolution and CommonJS output"

Return a JSON array of strings. Each string should be a self-contained fact (understandable without the original conversation). Maximum 500 characters per fact. If there are no notable facts, return an empty array [].`,
  },
};

export function getDomainIds(): string[] {
  return Object.keys(DOMAIN_REGISTRY);
}

export function getDomain(id: string): MemoryDomain {
  return DOMAIN_REGISTRY[id] ?? DOMAIN_REGISTRY[DEFAULT_DOMAIN];
}

<!-- Moved out of CLAUDE.md, which keeps a pointer here. -->

# src/custom-providers.ts

- **src/custom-providers.ts** — `CustomProviderStore`: single-file JSON store at `~/.config/bernard/custom-providers.json`. Each entry binds a user-chosen `name` to one of the three installed SDKs (`openai` / `anthropic` / `xai`), a `baseURL`, a `defaultModel`, and a remembered `models[]` list that grows as the user types new names in `/model`. Reserved names: `anthropic`, `openai`, `xai`.

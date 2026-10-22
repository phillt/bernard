<!-- Moved out of CLAUDE.md, which keeps a pointer here. -->

# src/providers/

- **src/providers/** — `getModel()` factory returning AI SDK `LanguageModel`. `getModelForConfig(config, provider, model)` wraps it to consult `config.customProviders` and route through `createOpenAI` / `createAnthropic` / `createXai` with `{ baseURL, apiKey }` when the active provider is user-defined.

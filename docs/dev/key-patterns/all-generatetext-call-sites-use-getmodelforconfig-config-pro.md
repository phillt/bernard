<!-- Moved out of CLAUDE.md, which keeps a pointer here. -->

# All generateText call sites use getModelForConfig(config, provider, model) + getProviderOptionsForConfig(config, provider) rather than calling getModel/getProviderOptions directly, so custom-provider endpoints are routed transparently.

- All `generateText` call sites use `getModelForConfig(config, provider, model)` + `getProviderOptionsForConfig(config, provider)` rather than calling `getModel`/`getProviderOptions` directly, so custom-provider endpoints are routed transparently.

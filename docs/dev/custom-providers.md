<!-- Moved out of CLAUDE.md, which keeps a pointer here. -->

## Custom Providers

Users can register named **custom providers** that wrap one of the installed SDKs (`openai`, `anthropic`, `xai`) and point it at a non-default endpoint — Ollama, LM Studio, OpenRouter, internal gateways, etc. Multiple custom providers can coexist with the built-ins.

```bash
# CLI:
bernard add-provider ollama --sdk openai --base-url http://localhost:11434/v1 --model llama3.2 [--key <api-key>]
bernard remove-provider ollama
bernard providers                # lists built-ins and custom side-by-side

# REPL:
/provider                        # menu now ends with "+ Add custom provider…" (interactive wizard)
/model                           # for a custom provider, menu ends with "+ Type a new model name…"
```

Keys for custom providers are stored in `keys.json` (same path as built-ins) and never injected into `process.env`. Built-in providers are unaffected.

<!-- Moved out of CLAUDE.md, which keeps a pointer here. -->

## Settings Profiles

User-tunable settings are organized into named **profiles** (#207). Bernard always has at least one (`default`); `activeProfileId` in `~/.config/bernard/profiles.json` nominates which one is live. Every `savePreferences` call writes to the active profile, so any settings change made via `/agent-options`, `/model`, `/provider`, `/theme`, `bernard set-model-mode`, etc. is automatically profile-scoped. API keys (`keys.json`) and custom providers (`custom-providers.json`) stay global.

- `/profiles` — list profiles (active one marked), switch, or launch the wizard to create a new one.
- `/manage-profiles` — rename or delete (guards against deleting the active or last-remaining profile).
- `bernard profiles` — read-only listing from the CLI.

`src/profiles.ts` is the disk-backed store (CRUD + atomic writes); `src/profiles-wizard-data.ts` defines the field registry (Model / Agent behavior / Memory & context / Tool safety / Output style / Voice / Automation / Limits) that both `/setup` and `/profiles` → create read.

Migration: the first read of `profiles.json` is lazy; if the file is absent but `~/.config/bernard/preferences.json` exists, its contents seed the `default` profile and a `.migrated-to-profiles` marker is dropped (subsequent loads consult the marker to avoid re-ingesting stale legacy settings if `profiles.json` is later removed). The legacy `preferences.json` is left in place (no destructive delete) so users can roll back. Brand-new users (neither file present) get the wizard at REPL start to customize their `default` profile.

Resolution precedence in `loadConfig` matches the pre-profiles behavior: **CLI overrides > active profile (stored prefs) > environment variables > built-in defaults**. The profile is the preferences layer — storing a value in the active profile shadows the matching env var (e.g. `BERNARD_MODEL`, `BERNARD_MODEL_MODE`). To let an env var take effect again, reset the field from `/agent-options` or use a fresh profile that omits it.

Profile switching mid-session calls `applyProfileToConfig(config)` (`src/config.ts`) which re-runs `loadConfig()` and copies only the profile-scoped fields back onto the live `config` reference, so subsystems holding that reference (agent loop, tool augment layer) see the new values without reinitialization. `setMaxConcurrentAgents()` is re-fired inside `loadConfig()` so the shared agent pool reflects the new cap.

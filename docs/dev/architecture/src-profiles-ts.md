<!-- Moved out of CLAUDE.md, which keeps a pointer here. -->

# src/profiles.ts

- **src/profiles.ts** — Settings-profile store (#207) at `~/.config/bernard/profiles.json`. CRUD + atomic writes + lazy migration from legacy `preferences.json`. `loadPreferences` / `savePreferences` in `src/config.ts` are now thin shims that read/write the active profile's `settings` blob, so every existing settings call site is automatically profile-scoped.

<!-- Moved out of CLAUDE.md, which keeps a pointer here. -->

# Dangerous-command safelist: shell commands whose target path starts with BERNARD_TMP_PREFIX (an internal constant exported from src/tools/shell.ts, equal to path.join(os.tmpdir(), 'bernard-') — not a user-facing env var) and contain no shell metacharacters skip the confirmation menu. Intentionally narrow so Bernard's own scratch-script cleanup doesn't pop a prompt; arbitrary rm still confirms.

- Dangerous-command safelist: shell commands whose target path starts with `BERNARD_TMP_PREFIX` (an internal constant exported from `src/tools/shell.ts`, equal to `path.join(os.tmpdir(), 'bernard-')` — not a user-facing env var) and contain no shell metacharacters skip the confirmation menu. Intentionally narrow so Bernard's own scratch-script cleanup doesn't pop a prompt; arbitrary `rm` still confirms.

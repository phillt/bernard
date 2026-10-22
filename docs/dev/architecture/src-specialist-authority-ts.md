<!-- Moved out of CLAUDE.md, which keeps a pointer here. -->

# src/specialist-authority.ts

- **src/specialist-authority.ts** — Authoritative role/permission layer for specialists. Resolves a `SpecialistRole` (`builtin` | `user`) from the shipped `builtin-specialists/` manifest (never from an on-disk field — so a tampered record can't bypass protection) and exposes `permissionsFor(id)`, `ProtectedSpecialistError`, and the `assertCanDeleteSpecialist` / `assertCanEditSpecialist` guards. The `SpecialistStore` is the single enforcement chokepoint: `delete()` / `update()` call the guards and throw; `appendExamples()` deliberately bypasses them so the correction flow can still teach bundled wrappers. Bundled specialists are fully frozen (no delete, no definition edit, no enable/disable) except for that learned-example carve-out. The REPL `/specialists` menu and the agent `specialist` tool consult the same authority to refuse and surface a 🔒.

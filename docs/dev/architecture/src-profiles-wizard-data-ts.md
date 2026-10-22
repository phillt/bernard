<!-- Moved out of CLAUDE.md, which keeps a pointer here. -->

# src/profiles-wizard-data.ts

- **src/profiles-wizard-data.ts** — the declarative field registry behind every settings wizard. A pure data tree (no Ink, no readline) so any host can interpret it; the legacy `src/profiles-wizard.ts` that paired field metadata with readline pickers is long gone, and `runProfileWizardInk` (`App.tsx`) is what `/profiles` → create runs. See **Setup** below for the coverage invariant.

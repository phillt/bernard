import { cpSync } from 'node:fs';

cpSync('src/builtin-specialists', 'dist/builtin-specialists', { recursive: true });
cpSync('src/builtin-apps', 'dist/builtin-apps', { recursive: true });
cpSync('src/data', 'dist/data', { recursive: true });
// The first `.md` shipped as tool-readable data rather than JSON. `docs-store.ts`
// resolves it beside the loaded module, so this is what makes `dist/docs` exist.
cpSync('src/docs', 'dist/docs', { recursive: true });

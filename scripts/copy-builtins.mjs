import { cpSync } from 'node:fs';

cpSync('src/builtin-specialists', 'dist/builtin-specialists', { recursive: true });
cpSync('src/data', 'dist/data', { recursive: true });

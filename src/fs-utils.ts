import * as fs from 'node:fs';

/** Writes `data` to a `.tmp` file then renames it into place for crash-safe persistence. */
export function atomicWriteFileSync(filePath: string, data: string): void {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, data, 'utf-8');
  fs.renameSync(tmp, filePath);
}

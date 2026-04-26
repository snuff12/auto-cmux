import { mkdirSync, writeFileSync, renameSync } from 'fs';
import { dirname } from 'path';

/**
 * Atomically write JSON data to a file (write to .tmp, then rename).
 * Ensures the file is never left in a half-written state.
 */
export function atomicWriteJson(filePath: string, data: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  renameSync(tmp, filePath);
}

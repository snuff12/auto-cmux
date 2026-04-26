import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { atomicWriteJson } from './fs-utils.js';

describe('atomicWriteJson', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'fs-utils-'));
  });

  it('writes valid JSON to the target file', () => {
    const filePath = join(tmpDir, 'test.json');
    atomicWriteJson(filePath, { hello: 'world', count: 42 });

    const content = JSON.parse(readFileSync(filePath, 'utf8'));
    expect(content).toEqual({ hello: 'world', count: 42 });
  });

  it('creates parent directories if they do not exist', () => {
    const filePath = join(tmpDir, 'nested', 'deep', 'data.json');
    atomicWriteJson(filePath, [1, 2, 3]);

    const content = JSON.parse(readFileSync(filePath, 'utf8'));
    expect(content).toEqual([1, 2, 3]);
  });

  it('overwrites existing file atomically', () => {
    const filePath = join(tmpDir, 'overwrite.json');
    atomicWriteJson(filePath, { version: 1 });
    atomicWriteJson(filePath, { version: 2 });

    const content = JSON.parse(readFileSync(filePath, 'utf8'));
    expect(content).toEqual({ version: 2 });
  });

  it('does not leave a .tmp file after success', () => {
    const filePath = join(tmpDir, 'clean.json');
    atomicWriteJson(filePath, { ok: true });

    expect(existsSync(filePath)).toBe(true);
    expect(existsSync(`${filePath}.tmp`)).toBe(false);
  });

  it('pretty-prints JSON with 2-space indent', () => {
    const filePath = join(tmpDir, 'pretty.json');
    atomicWriteJson(filePath, { a: 1 });

    const raw = readFileSync(filePath, 'utf8');
    expect(raw).toBe(JSON.stringify({ a: 1 }, null, 2));
  });

  it('handles null and primitive values', () => {
    const filePath = join(tmpDir, 'null.json');
    atomicWriteJson(filePath, null);
    expect(JSON.parse(readFileSync(filePath, 'utf8'))).toBeNull();

    atomicWriteJson(filePath, 'just a string');
    expect(JSON.parse(readFileSync(filePath, 'utf8'))).toBe('just a string');
  });
});

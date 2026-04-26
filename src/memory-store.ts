import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
} from 'fs';
import { join, resolve } from 'path';
import { homedir } from 'os';
import type { MemoryEntry } from './types.js';

const SAFE_ID = /^[a-zA-Z0-9_-]+$/;

function sanitizeId(id: string, label: string): string {
  if (!SAFE_ID.test(id)) {
    throw new Error(`${label} must be alphanumeric/dash/underscore only, got: "${id}"`);
  }
  return id;
}

const DEFAULT_MEMORY_DIR = join(homedir(), '.auto-cmux', 'memory');

export class MemoryStore {
  private memoryDir: string;

  constructor(basePath?: string) {
    this.memoryDir = basePath
      ? join(basePath, 'memory')
      : DEFAULT_MEMORY_DIR;
  }

  private ensureDir(): void {
    if (!existsSync(this.memoryDir)) {
      mkdirSync(this.memoryDir, { recursive: true });
    }
  }

  private roleFilePath(roleId: string): string {
    sanitizeId(roleId, 'roleId');
    return join(this.memoryDir, `${roleId}.jsonl`);
  }

  private conventionsFilePath(): string {
    return join(this.memoryDir, 'conventions.jsonl');
  }

  // ── Role Memory ──

  /**
   * Save a role-specific memory entry.
   */
  saveRoleMemory(roleId: string, key: string, insight: string, confidence = 0.8): MemoryEntry {
    this.ensureDir();

    const entry: MemoryEntry = {
      type: 'role',
      key,
      insight,
      confidence: Math.max(0, Math.min(1, confidence)),
      timestamp: Date.now(),
    };

    appendFileSync(this.roleFilePath(roleId), JSON.stringify(entry) + '\n', 'utf8');
    return entry;
  }

  /**
   * Get all memory entries for a role.
   */
  getRoleMemory(roleId: string): MemoryEntry[] {
    return this.readJsonl(this.roleFilePath(roleId));
  }

  /**
   * Get deduplicated role memory (latest entry per key wins).
   */
  getRoleMemoryDeduped(roleId: string): MemoryEntry[] {
    const entries = this.getRoleMemory(roleId);
    return this.dedupeByKey(entries);
  }

  // ── Convention Memory ──

  /**
   * Save a project-wide convention.
   */
  saveConvention(key: string, insight: string, confidence = 0.9): MemoryEntry {
    this.ensureDir();

    const entry: MemoryEntry = {
      type: 'convention',
      key,
      insight,
      confidence: Math.max(0, Math.min(1, confidence)),
      timestamp: Date.now(),
    };

    appendFileSync(this.conventionsFilePath(), JSON.stringify(entry) + '\n', 'utf8');
    return entry;
  }

  /**
   * Get all convention entries.
   */
  getConventions(): MemoryEntry[] {
    return this.readJsonl(this.conventionsFilePath());
  }

  /**
   * Get deduplicated conventions (latest per key wins).
   */
  getConventionsDeduped(): MemoryEntry[] {
    const entries = this.getConventions();
    return this.dedupeByKey(entries);
  }

  // ── All Memory ──

  /**
   * Get all memory (all roles + conventions), optionally filtered by type.
   */
  getAll(type?: 'role' | 'convention'): MemoryEntry[] {
    const entries: MemoryEntry[] = [];

    if (!type || type === 'convention') {
      entries.push(...this.getConventions());
    }

    if (!type || type === 'role') {
      if (existsSync(this.memoryDir)) {
        for (const file of readdirSync(this.memoryDir)) {
          if (file === 'conventions.jsonl' || !file.endsWith('.jsonl')) continue;
          entries.push(...this.readJsonl(join(this.memoryDir, file)));
        }
      }
    }

    return entries.sort((a, b) => a.timestamp - b.timestamp);
  }

  /**
   * List all role IDs that have memory.
   */
  listRoles(): string[] {
    if (!existsSync(this.memoryDir)) return [];
    return readdirSync(this.memoryDir)
      .filter(f => f.endsWith('.jsonl') && f !== 'conventions.jsonl')
      .map(f => f.replace('.jsonl', ''));
  }

  // ── Prompt Injection ──

  /**
   * Build a memory section for an agent prompt.
   * Includes role-specific memory + conventions.
   */
  buildPromptSection(roleId?: string): string {
    const parts: string[] = [];

    // Conventions
    const conventions = this.getConventionsDeduped();
    if (conventions.length > 0) {
      parts.push('## Project Conventions');
      for (const c of conventions) {
        parts.push(`- **${c.key}**: ${c.insight}`);
      }
      parts.push('');
    }

    // Role-specific memory
    if (roleId) {
      const roleMemory = this.getRoleMemoryDeduped(roleId);
      if (roleMemory.length > 0) {
        parts.push(`## Role Memory (${roleId})`);
        for (const m of roleMemory) {
          parts.push(`- **${m.key}**: ${m.insight}`);
        }
        parts.push('');
      }
    }

    return parts.join('\n');
  }

  /**
   * Compact a JSONL file by deduplicating entries (latest per key).
   */
  compact(filePath: string): void {
    const entries = this.readJsonl(filePath);
    if (entries.length === 0) return;

    const deduped = this.dedupeByKey(entries);
    const tmp = `${filePath}.tmp`;
    writeFileSync(tmp, deduped.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8');
    renameSync(tmp, filePath);
  }

  /**
   * Compact all memory files.
   */
  compactAll(): void {
    if (!existsSync(this.memoryDir)) return;
    for (const file of readdirSync(this.memoryDir)) {
      if (!file.endsWith('.jsonl')) continue;
      this.compact(join(this.memoryDir, file));
    }
  }

  // ── Internal ──

  private readJsonl(filePath: string): MemoryEntry[] {
    if (!existsSync(filePath)) return [];

    const content = readFileSync(filePath, 'utf8');
    const entries: MemoryEntry[] = [];

    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        entries.push(JSON.parse(trimmed) as MemoryEntry);
      } catch {
        // Skip malformed lines
      }
    }

    return entries;
  }

  private dedupeByKey(entries: MemoryEntry[]): MemoryEntry[] {
    const map = new Map<string, MemoryEntry>();
    for (const entry of entries) {
      map.set(entry.key, entry);
    }
    return [...map.values()];
  }
}

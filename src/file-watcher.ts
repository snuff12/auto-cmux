import * as chokidar from 'chokidar';
import type { FSWatcher } from 'chokidar';
import { basename, dirname } from 'path';
import { EventEmitter } from 'events';

// ──────────────────────────────────────────────
// File system watcher for agent communication directories.
//
// Watches ~/.auto-cmux/agents/*/actions.md for changes and emits
// typed events so the orchestrator can trigger delta reads.
// ──────────────────────────────────────────────

export interface FileWatcherEvents {
  'actions-changed': (agentId: string) => void;
  'stream-changed': (agentId: string) => void;
  'error': (err: Error) => void;
}

export class FileWatcher extends EventEmitter {
  private watcher: FSWatcher | null = null;

  constructor(private basePath: string) {
    super();
  }

  start(): void {
    if (this.watcher) return;

    this.watcher = chokidar.watch(this.basePath, {
      ignoreInitial: true,
      ignored: [
        /node_modules/,
        /\.offset$/,
        /\.tmp$/,
      ],
      followSymlinks: false,
      awaitWriteFinish: {
        stabilityThreshold: 100,
        pollInterval: 50,
      },
    });

    const handleChange = (path: string) => {
      const filename = basename(path);
      if (filename !== 'actions.md' && filename !== 'stream.jsonl') return;

      // path: basePath/agents/{agentId}/actions.md
      const agentId = basename(dirname(path));
      if (agentId && agentId !== 'agents') {
        this.emit(filename === 'actions.md' ? 'actions-changed' : 'stream-changed', agentId);
      }
    };

    this.watcher.on('add', handleChange);
    this.watcher.on('change', handleChange);
    this.watcher.on('error', (err) => this.emit('error', err));
  }

  async stop(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
  }
}

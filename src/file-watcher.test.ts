import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock chokidar before importing FileWatcher
const mockWatch = vi.fn();
const mockClose = vi.fn().mockResolvedValue(undefined);
const mockOn = vi.fn();

vi.mock('chokidar', () => ({
  watch: (...args: unknown[]) => {
    mockWatch(...args);
    const handlers: Record<string, Function> = {};
    const watcher = {
      on: (event: string, handler: Function) => {
        handlers[event] = handler;
        mockOn(event, handler);
        return watcher;
      },
      close: mockClose,
      _handlers: handlers,
    };
    // Store for test access
    (globalThis as any).__lastWatcher = watcher;
    return watcher;
  },
}));

import { FileWatcher } from './file-watcher.js';

describe('FileWatcher', () => {
  let fw: FileWatcher;

  beforeEach(() => {
    vi.clearAllMocks();
    fw = new FileWatcher('/home/user/.auto-cmux');
  });

  it('creates a chokidar watcher on start()', () => {
    fw.start();
    expect(mockWatch).toHaveBeenCalledWith('/home/user/.auto-cmux', expect.objectContaining({
      ignoreInitial: true,
      followSymlinks: false,
    }));
  });

  it('does not create duplicate watchers on double start()', () => {
    fw.start();
    fw.start();
    expect(mockWatch).toHaveBeenCalledTimes(1);
  });

  it('emits actions-changed for actions.md file changes', () => {
    fw.start();
    const watcher = (globalThis as any).__lastWatcher;
    const spy = vi.fn();
    fw.on('actions-changed', spy);

    // Simulate file change
    const changeHandler = watcher._handlers['change'] || watcher._handlers['add'];
    changeHandler('/home/user/.auto-cmux/agents/agent-123/actions.md');

    expect(spy).toHaveBeenCalledWith('agent-123');
  });

  it('emits stream-changed for stream.jsonl file changes', () => {
    fw.start();
    const watcher = (globalThis as any).__lastWatcher;
    const spy = vi.fn();
    fw.on('stream-changed', spy);

    const addHandler = watcher._handlers['add'];
    addHandler('/home/user/.auto-cmux/agents/agent-456/stream.jsonl');

    expect(spy).toHaveBeenCalledWith('agent-456');
  });

  it('ignores non-actions/stream files', () => {
    fw.start();
    const watcher = (globalThis as any).__lastWatcher;
    const actionsSpy = vi.fn();
    const streamSpy = vi.fn();
    fw.on('actions-changed', actionsSpy);
    fw.on('stream-changed', streamSpy);

    const changeHandler = watcher._handlers['change'];
    changeHandler('/home/user/.auto-cmux/agents/agent-123/inbox.md');

    expect(actionsSpy).not.toHaveBeenCalled();
    expect(streamSpy).not.toHaveBeenCalled();
  });

  it('ignores changes where parent dir is "agents" (no real agentId)', () => {
    fw.start();
    const watcher = (globalThis as any).__lastWatcher;
    const spy = vi.fn();
    fw.on('actions-changed', spy);

    const changeHandler = watcher._handlers['change'];
    // If actions.md is directly in the agents dir (no agentId subfolder)
    changeHandler('/home/user/.auto-cmux/agents/actions.md');

    // agentId would be 'agents' — should be filtered out
    expect(spy).not.toHaveBeenCalled();
  });

  it('forwards chokidar errors as error events', () => {
    fw.start();
    const watcher = (globalThis as any).__lastWatcher;
    const spy = vi.fn();
    fw.on('error', spy);

    const err = new Error('watch failed');
    watcher._handlers['error'](err);

    expect(spy).toHaveBeenCalledWith(err);
  });

  it('stop() closes the watcher', async () => {
    fw.start();
    await fw.stop();
    expect(mockClose).toHaveBeenCalled();
  });

  it('stop() is safe when no watcher exists', async () => {
    await expect(fw.stop()).resolves.toBeUndefined();
  });

  it('can restart after stop', async () => {
    fw.start();
    await fw.stop();
    fw.start();
    expect(mockWatch).toHaveBeenCalledTimes(2);
  });
});

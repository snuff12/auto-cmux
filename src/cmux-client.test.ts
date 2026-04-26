import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CmuxClient, CmuxError } from './cmux-client.js';

// ── CmuxError ──────────────────────────────────────────────────────────────

describe('CmuxError', () => {
  it('sets name, message, code, and data', () => {
    const err = new CmuxError('test error', 'ECODE', { detail: 1 });
    expect(err.name).toBe('CmuxError');
    expect(err.message).toBe('test error');
    expect(err.code).toBe('ECODE');
    expect(err.data).toEqual({ detail: 1 });
    expect(err).toBeInstanceOf(Error);
  });

  it('works without optional fields', () => {
    const err = new CmuxError('simple');
    expect(err.code).toBeUndefined();
    expect(err.data).toBeUndefined();
  });
});

// ── CmuxClient constructor & state ─────────────────────────────────────────

describe('CmuxClient constructor', () => {
  it('defaults to not connected', () => {
    const client = new CmuxClient({ socketPath: '/tmp/test.sock', reconnect: false });
    expect(client.isConnected()).toBe(false);
  });

  it('accepts custom options', () => {
    const client = new CmuxClient({
      socketPath: '/custom/path.sock',
      requestTimeout: 5000,
      reconnect: false,
      reconnectMaxDelay: 10000,
      pingInterval: 15000,
    });
    expect(client.isConnected()).toBe(false);
  });
});

// ── call() without connection ──────────────────────────────────────────────

describe('CmuxClient.call without connection', () => {
  it('throws CmuxError when not connected', async () => {
    const client = new CmuxClient({ socketPath: '/tmp/test.sock', reconnect: false });
    await expect(client.call('system.ping')).rejects.toThrow('Not connected');
    await expect(client.call('system.ping')).rejects.toBeInstanceOf(CmuxError);
  });
});

// ── setStatus throws ───────────────────────────────────────────────────────

describe('CmuxClient.setStatus', () => {
  it('throws unsupported error', async () => {
    const client = new CmuxClient({ socketPath: '/tmp/test.sock', reconnect: false });
    await expect(client.setStatus('key', 'val')).rejects.toThrow('setStatus is not supported');
    try {
      await client.setStatus('key', 'val');
    } catch (e: any) {
      expect(e.code).toBe('unsupported');
    }
  });
});

// ── disconnect() cleans up ─────────────────────────────────────────────────

describe('CmuxClient.disconnect', () => {
  it('is safe to call when not connected', () => {
    const client = new CmuxClient({ socketPath: '/tmp/test.sock', reconnect: false });
    expect(() => client.disconnect()).not.toThrow();
    expect(client.isConnected()).toBe(false);
  });
});

// ── processBuffer (via simulated socket data) ──────────────────────────────

describe('CmuxClient processBuffer', () => {
  it('resolves pending requests on successful response', async () => {
    const client = new CmuxClient({ socketPath: '/tmp/test.sock', reconnect: false, pingInterval: 0 });

    // Manually set connected state and create a mock socket
    const mockSocket = {
      write: vi.fn(),
      destroy: vi.fn(),
      on: vi.fn(),
      removeAllListeners: vi.fn(),
    };
    (client as any).connected = true;
    (client as any).socket = mockSocket;

    // Start a call (will be pending)
    const callPromise = client.call('system.ping');

    // The call writes to the socket — extract the request id
    expect(mockSocket.write).toHaveBeenCalledTimes(1);
    const written = mockSocket.write.mock.calls[0][0];
    const req = JSON.parse(written.trim());
    expect(req.method).toBe('system.ping');

    // Simulate receiving a response by feeding data into processBuffer
    (client as any).recvBuffer = JSON.stringify({ id: req.id, ok: true, result: { pong: true } }) + '\n';
    (client as any).processBuffer();

    const result = await callPromise;
    expect(result).toEqual({ pong: true });
  });

  it('rejects pending requests on error response', async () => {
    const client = new CmuxClient({ socketPath: '/tmp/test.sock', reconnect: false, pingInterval: 0 });

    const mockSocket = { write: vi.fn(), destroy: vi.fn(), on: vi.fn() };
    (client as any).connected = true;
    (client as any).socket = mockSocket;

    const callPromise = client.call('bad.method');
    const written = mockSocket.write.mock.calls[0][0];
    const req = JSON.parse(written.trim());

    (client as any).recvBuffer = JSON.stringify({
      id: req.id,
      ok: false,
      error: { code: 'not_found', message: 'Method not found' },
    }) + '\n';
    (client as any).processBuffer();

    await expect(callPromise).rejects.toThrow('not_found: Method not found');
  });

  it('handles partial buffer (no newline yet)', async () => {
    const client = new CmuxClient({ socketPath: '/tmp/test.sock', reconnect: false, pingInterval: 0 });

    const mockSocket = { write: vi.fn(), destroy: vi.fn(), on: vi.fn() };
    (client as any).connected = true;
    (client as any).socket = mockSocket;

    const callPromise = client.call('system.ping');
    const written = mockSocket.write.mock.calls[0][0];
    const req = JSON.parse(written.trim());

    // Feed partial data (no newline)
    const fullResponse = JSON.stringify({ id: req.id, ok: true, result: { pong: true } });
    (client as any).recvBuffer = fullResponse; // no trailing \n
    (client as any).processBuffer();

    // Should still be pending since there's no complete line
    // Now complete the line
    (client as any).recvBuffer += '\n';
    (client as any).processBuffer();

    const result = await callPromise;
    expect(result).toEqual({ pong: true });
  });

  it('handles malformed JSON in buffer gracefully', () => {
    const client = new CmuxClient({ socketPath: '/tmp/test.sock', reconnect: false, pingInterval: 0 });

    const errorSpy = vi.fn();
    client.on('error', errorSpy);

    (client as any).recvBuffer = 'not valid json\n';
    (client as any).processBuffer();

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0][0]).toBeInstanceOf(CmuxError);
  });

  it('skips empty lines in buffer', () => {
    const client = new CmuxClient({ socketPath: '/tmp/test.sock', reconnect: false, pingInterval: 0 });

    const errorSpy = vi.fn();
    client.on('error', errorSpy);

    (client as any).recvBuffer = '\n\n\n';
    (client as any).processBuffer();

    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('ignores responses with unknown ids', () => {
    const client = new CmuxClient({ socketPath: '/tmp/test.sock', reconnect: false, pingInterval: 0 });

    (client as any).recvBuffer = JSON.stringify({ id: 99999, ok: true, result: {} }) + '\n';
    // Should not throw
    expect(() => (client as any).processBuffer()).not.toThrow();
  });
});

// ── handleDisconnect ───────────────────────────────────────────────────────

describe('CmuxClient handleDisconnect', () => {
  it('rejects all pending requests on disconnect', async () => {
    const client = new CmuxClient({ socketPath: '/tmp/test.sock', reconnect: false, pingInterval: 0 });

    const mockSocket = { write: vi.fn(), destroy: vi.fn(), on: vi.fn() };
    (client as any).connected = true;
    (client as any).socket = mockSocket;

    const p1 = client.call('method1');
    const p2 = client.call('method2');

    // Simulate disconnect
    (client as any).handleDisconnect();

    await expect(p1).rejects.toThrow('Socket closed');
    await expect(p2).rejects.toThrow('Socket closed');
    expect(client.isConnected()).toBe(false);
  });
});

// ── formatConnectionError ──────────────────────────────────────────────────

describe('CmuxClient formatConnectionError', () => {
  it('formats ENOENT as not-running message', () => {
    const client = new CmuxClient({ socketPath: '/tmp/test.sock', reconnect: false });
    const msg = (client as any).formatConnectionError({ code: 'ENOENT', message: 'no such file' });
    expect(msg).toContain('not running');
    expect(msg).toContain('/tmp/test.sock');
  });

  it('formats ECONNREFUSED', () => {
    const client = new CmuxClient({ socketPath: '/tmp/test.sock', reconnect: false });
    const msg = (client as any).formatConnectionError({ code: 'ECONNREFUSED', message: 'refused' });
    expect(msg).toContain('refused');
  });

  it('formats EACCES', () => {
    const client = new CmuxClient({ socketPath: '/tmp/test.sock', reconnect: false });
    const msg = (client as any).formatConnectionError({ code: 'EACCES', message: 'perm' });
    expect(msg).toContain('Permission denied');
  });

  it('formats ETIMEDOUT', () => {
    const client = new CmuxClient({ socketPath: '/tmp/test.sock', reconnect: false });
    const msg = (client as any).formatConnectionError({ code: 'ETIMEDOUT', message: 'timeout' });
    expect(msg).toContain('timed out');
  });

  it('formats ECONNRESET', () => {
    const client = new CmuxClient({ socketPath: '/tmp/test.sock', reconnect: false });
    const msg = (client as any).formatConnectionError({ code: 'ECONNRESET', message: 'reset' });
    expect(msg).toContain('unexpectedly');
  });

  it('formats unknown errors with original message', () => {
    const client = new CmuxClient({ socketPath: '/tmp/test.sock', reconnect: false });
    const msg = (client as any).formatConnectionError({ code: 'EUNKNOWN', message: 'something weird' });
    expect(msg).toContain('something weird');
  });
});

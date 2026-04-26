import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ReactionsDispatcher, DEFAULT_RULES, DEFAULT_STALL_TIMEOUT_MS } from './reactions.js';
import type { Agent } from './types.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-1',
    name: 'test-agent',
    cli: 'claude',
    workspaceId: 'ws-1',
    surfaceId: 'surf-1',
    status: 'working',
    taskSentAt: Date.now() - 200_000, // 200s ago
    lastActionAt: Date.now() - 200_000,
    cwd: '/tmp',
    lastPrompt: 'do something',
    ...overrides,
  };
}

function createMocks(agents: Agent[] = [makeAgent()]) {
  const agentManager = {
    list: vi.fn(() => agents),
    get: vi.fn((id: string) => agents.find(a => a.id === id)),
    retryTask: vi.fn(async () => {}),
    kill: vi.fn(async () => {}),
    setStatus: vi.fn(),
  };

  const fileProtocol = {
    writeInbox: vi.fn(),
  };

  const cmuxClient = {
    sendText: vi.fn(async () => {}),
    readText: vi.fn(async () => ''),
    notify: vi.fn(async () => {}),
  };

  return { agentManager, fileProtocol, cmuxClient };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('ReactionsDispatcher', () => {
  let dispatcher: ReactionsDispatcher;
  let mocks: ReturnType<typeof createMocks>;

  beforeEach(() => {
    mocks = createMocks();
    dispatcher = new ReactionsDispatcher(
      mocks.agentManager,
      mocks.fileProtocol,
      mocks.cmuxClient,
    );
  });

  afterEach(() => {
    dispatcher.destroy();
  });

  describe('dispatch', () => {
    it('should execute diagnose action for stall event', async () => {
      const result = await dispatcher.dispatch('stall', 'agent-1', 'No activity for 130s');
      expect(result).toBe('diagnose');
      expect(mocks.fileProtocol.writeInbox).toHaveBeenCalledWith('agent-1', expect.stringContaining('stuck'));
    });

    it('should create alert for hitl event (non-auto)', async () => {
      const alertSpy = vi.fn();
      dispatcher.on('alert', alertSpy);

      const result = await dispatcher.dispatch('hitl', 'agent-1', 'Confirmation required');
      expect(result).toBe('alert');
      expect(alertSpy).toHaveBeenCalledWith(expect.objectContaining({
        agentId: 'agent-1',
        event: 'hitl',
      }));
      expect(dispatcher.getActiveAlerts()).toHaveLength(1);
    });

    it('should send /compact for low-context event', async () => {
      const result = await dispatcher.dispatch('low-context', 'agent-1');
      expect(result).toBe('compact');
      expect(mocks.cmuxClient.sendText).toHaveBeenCalledWith('surf-1', '/compact\n');
    });

    it('should retry for agent-crashed event', async () => {
      const result = await dispatcher.dispatch('agent-crashed', 'agent-1');
      expect(result).toBe('retry');
      expect(mocks.agentManager.retryTask).toHaveBeenCalledWith('agent-1');
    });

    it('should return "none" for unknown event', async () => {
      const result = await dispatcher.dispatch('unknown-event' as any, 'agent-1');
      expect(result).toBe('none');
    });
  });

  describe('cooldown', () => {
    it('should block dispatch within cooldown period', async () => {
      // agent-crashed has 5000ms cooldown
      await dispatcher.dispatch('agent-crashed', 'agent-1');
      const result = await dispatcher.dispatch('agent-crashed', 'agent-1');
      expect(result).toBe('none');
      expect(mocks.agentManager.retryTask).toHaveBeenCalledTimes(1);
    });

    it('should allow dispatch after cooldown expires', async () => {
      vi.useFakeTimers();
      try {
        await dispatcher.dispatch('agent-crashed', 'agent-1');
        vi.advanceTimersByTime(6_000); // past 5000ms cooldown
        await dispatcher.dispatch('agent-crashed', 'agent-1');
        expect(mocks.agentManager.retryTask).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('escalation', () => {
    it('should escalate after max retries', async () => {
      const escalatedSpy = vi.fn();
      dispatcher.on('escalated', escalatedSpy);

      // agent-crashed: escalateAfter=2, cooldownMs=5000
      vi.useFakeTimers();
      try {
        await dispatcher.dispatch('agent-crashed', 'agent-1');
        vi.advanceTimersByTime(6_000);
        await dispatcher.dispatch('agent-crashed', 'agent-1');
        vi.advanceTimersByTime(6_000);

        const result = await dispatcher.dispatch('agent-crashed', 'agent-1');
        expect(result).toBe('escalate');
        expect(escalatedSpy).toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('should track retry count correctly', async () => {
      vi.useFakeTimers();
      try {
        expect(dispatcher.getRetryCount('agent-1', 'stall')).toBe(0);
        await dispatcher.dispatch('stall', 'agent-1');
        expect(dispatcher.getRetryCount('agent-1', 'stall')).toBe(1);
        vi.advanceTimersByTime(31_000);
        await dispatcher.dispatch('stall', 'agent-1');
        expect(dispatcher.getRetryCount('agent-1', 'stall')).toBe(2);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('alert resolution', () => {
    it('should resolve an alert', async () => {
      await dispatcher.dispatch('hitl', 'agent-1', 'y/n prompt');
      const alerts = dispatcher.getActiveAlerts();
      expect(alerts).toHaveLength(1);

      const resolved = dispatcher.resolveAlert(alerts[0].id, 'Approved: yes');
      expect(resolved).not.toBeNull();
      expect(resolved!.resolved).toBe(true);
      expect(resolved!.resolution).toBe('Approved: yes');
      expect(dispatcher.getActiveAlerts()).toHaveLength(0);
    });

    it('should return null for unknown alert id', () => {
      const result = dispatcher.resolveAlert('nonexistent', 'x');
      expect(result).toBeNull();
    });
  });

  describe('resetAgent', () => {
    it('should clear retry and cooldown state for an agent', async () => {
      await dispatcher.dispatch('stall', 'agent-1');
      expect(dispatcher.getRetryCount('agent-1', 'stall')).toBe(1);

      dispatcher.resetAgent('agent-1');
      expect(dispatcher.getRetryCount('agent-1', 'stall')).toBe(0);
    });
  });

  describe('stall detection', () => {
    it('should detect stalled agents', async () => {
      const agent = makeAgent({
        status: 'working',
        lastActionAt: Date.now() - DEFAULT_STALL_TIMEOUT_MS - 1000,
      });
      mocks = createMocks([agent]);
      dispatcher = new ReactionsDispatcher(mocks.agentManager, mocks.fileProtocol, mocks.cmuxClient);

      await dispatcher.checkStalls();
      expect(mocks.fileProtocol.writeInbox).toHaveBeenCalledWith('agent-1', expect.any(String));
    });

    it('should not flag active agents', async () => {
      const agent = makeAgent({
        status: 'working',
        lastActionAt: Date.now() - 10_000, // 10s ago, well within threshold
      });
      mocks = createMocks([agent]);
      dispatcher = new ReactionsDispatcher(mocks.agentManager, mocks.fileProtocol, mocks.cmuxClient);

      await dispatcher.checkStalls();
      expect(mocks.fileProtocol.writeInbox).not.toHaveBeenCalled();
    });

    it('should skip non-working agents', async () => {
      const agent = makeAgent({
        status: 'idle',
        lastActionAt: Date.now() - DEFAULT_STALL_TIMEOUT_MS - 1000,
      });
      mocks = createMocks([agent]);
      dispatcher = new ReactionsDispatcher(mocks.agentManager, mocks.fileProtocol, mocks.cmuxClient);

      await dispatcher.checkStalls();
      expect(mocks.fileProtocol.writeInbox).not.toHaveBeenCalled();
    });

    it('should use taskSentAt as fallback when lastActionAt is missing', async () => {
      const agent = makeAgent({
        status: 'working',
        lastActionAt: undefined,
        taskSentAt: Date.now() - DEFAULT_STALL_TIMEOUT_MS - 5000,
      });
      mocks = createMocks([agent]);
      dispatcher = new ReactionsDispatcher(mocks.agentManager, mocks.fileProtocol, mocks.cmuxClient);

      await dispatcher.checkStalls();
      expect(mocks.fileProtocol.writeInbox).toHaveBeenCalled();
    });

    it('should mark agent as dead when surface readText throws', async () => {
      const agent = makeAgent({
        status: 'working',
        lastActionAt: Date.now() - DEFAULT_STALL_TIMEOUT_MS - 1000,
      });
      mocks = createMocks([agent]);
      mocks.cmuxClient.readText.mockRejectedValue(new Error('surface gone'));
      dispatcher = new ReactionsDispatcher(mocks.agentManager, mocks.fileProtocol, mocks.cmuxClient);

      await dispatcher.checkStalls();
      expect(mocks.agentManager.setStatus).toHaveBeenCalledWith('agent-1', 'dead');
      expect(mocks.fileProtocol.writeInbox).not.toHaveBeenCalled();
    });

    it('should not mark agent as dead when surface is alive', async () => {
      const agent = makeAgent({
        status: 'working',
        lastActionAt: Date.now() - DEFAULT_STALL_TIMEOUT_MS - 1000,
      });
      mocks = createMocks([agent]);
      dispatcher = new ReactionsDispatcher(mocks.agentManager, mocks.fileProtocol, mocks.cmuxClient);

      await dispatcher.checkStalls();
      expect(mocks.agentManager.setStatus).not.toHaveBeenCalledWith('agent-1', 'dead');
      expect(mocks.fileProtocol.writeInbox).toHaveBeenCalled();
    });
  });

  describe('rule overrides', () => {
    it('should merge user overrides with defaults', () => {
      const d = new ReactionsDispatcher(
        mocks.agentManager, mocks.fileProtocol, mocks.cmuxClient,
        { rules: [{ event: 'stall', retries: 10 }] },
      );
      const stallRule = d.getRules().find(r => r.event === 'stall')!;
      expect(stallRule.retries).toBe(10);
      expect(stallRule.action).toBe('diagnose'); // preserved from default
      d.destroy();
    });

    it('should use custom stall timeout', async () => {
      const agent = makeAgent({
        status: 'working',
        lastActionAt: Date.now() - 50_000, // 50s ago
      });
      mocks = createMocks([agent]);

      // Custom 30s timeout → should trigger
      dispatcher = new ReactionsDispatcher(
        mocks.agentManager, mocks.fileProtocol, mocks.cmuxClient,
        { stallTimeoutMs: 30_000 },
      );

      await dispatcher.checkStalls();
      expect(mocks.fileProtocol.writeInbox).toHaveBeenCalled();
    });
  });

  describe('diagnose prompts', () => {
    it('should send escalating diagnose prompts', async () => {
      vi.useFakeTimers();
      try {
        // 1st diagnose
        await dispatcher.dispatch('stall', 'agent-1');
        const first = mocks.fileProtocol.writeInbox.mock.calls[0][1];

        // 2nd diagnose (after cooldown)
        vi.advanceTimersByTime(31_000);
        await dispatcher.dispatch('stall', 'agent-1');
        const second = mocks.fileProtocol.writeInbox.mock.calls[1][1];

        // 3rd diagnose (after cooldown)
        vi.advanceTimersByTime(31_000);
        await dispatcher.dispatch('stall', 'agent-1');
        const third = mocks.fileProtocol.writeInbox.mock.calls[2][1];

        // All three should be different prompts
        expect(first).not.toBe(second);
        expect(second).not.toBe(third);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('getRules', () => {
    it('should return a copy of rules', () => {
      const rules = dispatcher.getRules();
      expect(rules).toHaveLength(DEFAULT_RULES.length);
      rules.push({} as any);
      expect(dispatcher.getRules()).toHaveLength(DEFAULT_RULES.length); // original unchanged
    });
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ActionProcessor } from './action-processor.js';
import type { Agent, ProjectConfig } from './types.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-1',
    name: 'worker-1',
    cli: 'claude',
    workspaceId: 'ws-1',
    surfaceId: 'surf-1',
    status: 'working',
    cwd: '/tmp/project',
    childIds: [],
    depth: 0,
    ...overrides,
  };
}

const defaultConfig: ProjectConfig = {
  version: '0.1',
  project: { name: 'test', root: '.' },
  agents: {
    roles: [
      { id: 'backend', cli: 'claude' },
      { id: 'frontend', cli: 'claude' },
    ],
    assignment: { mode: 'manual', stallTimeoutSec: 120 },
  },
  reactions: [],
  git: { worktreeEnabled: false, branchPrefix: 'agent/' },
  costs: { dailyLimitCents: 2500, warnAt: 0.8 },
};

function createMocks(agents: Agent[] = [makeAgent()]) {
  const spawnedAgents: Agent[] = [];
  let spawnCounter = 0;

  const agentManager = {
    get: vi.fn((id: string) => agents.find(a => a.id === id)),
    findByName: vi.fn((name: string) => agents.find(a => a.name === name)),
    list: vi.fn(() => agents),
    spawn: vi.fn(async (name: string, cli: string, _prompt: string, _cwd?: string, options?: { parentId?: string; roleId?: string }) => {
      spawnCounter++;
      const newAgent = makeAgent({
        id: `spawned-${spawnCounter}`,
        name,
        cli: cli as Agent['cli'],
        status: 'working',
        parentId: options?.parentId,
        roleId: options?.roleId,
      });
      spawnedAgents.push(newAgent);
      agents.push(newAgent);
      return newAgent;
    }),
    assignTask: vi.fn(async () => {}),
    resumeWithMessage: vi.fn(async () => true),
    on: vi.fn(),
    off: vi.fn(),
  };

  const fileProtocol = {
    writeInbox: vi.fn(),
  };

  const cmuxClient = {
    notify: vi.fn(async () => {}),
  };

  return { agentManager, fileProtocol, cmuxClient, spawnedAgents };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('ActionProcessor', () => {
  let processor: ActionProcessor;
  let mocks: ReturnType<typeof createMocks>;

  beforeEach(() => {
    mocks = createMocks();
    processor = new ActionProcessor(
      mocks.agentManager,
      mocks.fileProtocol,
      mocks.cmuxClient,
      () => defaultConfig,
    );
  });

  afterEach(() => {
    processor.destroy();
  });

  describe('spawn action', () => {
    it('should spawn a sub-agent and notify parent', async () => {
      const spy = vi.fn();
      processor.on('spawn_processed', spy);

      const handled = await processor.processAction('agent-1', {
        action: 'spawn',
        name: 'researcher',
        cli: 'claude',
        prompt: 'research topic X',
      });

      expect(handled).toBe(true);
      expect(mocks.agentManager.spawn).toHaveBeenCalledWith(
        'researcher', 'claude', 'research topic X', '/tmp/project',
        { parentId: 'agent-1' },
      );
      expect(mocks.fileProtocol.writeInbox).toHaveBeenCalledWith(
        'agent-1',
        expect.stringContaining('Sub-agent "researcher" Spawned'),
      );
      expect(spy).toHaveBeenCalled();
    });

    it('should notify parent on spawn failure', async () => {
      mocks.agentManager.spawn.mockRejectedValueOnce(new Error('name taken'));

      await processor.processAction('agent-1', {
        action: 'spawn',
        name: 'researcher',
        cli: 'claude',
        prompt: 'research topic X',
      });

      expect(mocks.fileProtocol.writeInbox).toHaveBeenCalledWith(
        'agent-1',
        expect.stringContaining('Spawn Failed'),
      );
    });

    it('should return false for unhandled actions', async () => {
      const handled = await processor.processAction('agent-1', { action: 'done', summary: 'ok' });
      expect(handled).toBe(false);
    });
  });

  describe('delegate_to action', () => {
    it('should spawn new agent when no idle agent exists for role', async () => {
      const spy = vi.fn();
      processor.on('delegate_processed', spy);

      await processor.processAction('agent-1', {
        action: 'delegate_to',
        role: 'backend',
        task: 'implement API endpoint',
      });

      expect(mocks.agentManager.spawn).toHaveBeenCalledWith(
        expect.stringContaining('backend-'),
        'claude',
        'implement API endpoint',
        '/tmp/project',
        { parentId: 'agent-1', roleId: 'backend' },
      );
      expect(mocks.fileProtocol.writeInbox).toHaveBeenCalledWith(
        'agent-1',
        expect.stringContaining('Delegated to'),
      );
      expect(spy).toHaveBeenCalled();
    });

    it('should reuse idle agent matching the role', async () => {
      const idleBackend = makeAgent({
        id: 'backend-1',
        name: 'backend-existing',
        status: 'idle',
        roleId: 'backend',
      });
      const agents = [makeAgent(), idleBackend];
      mocks = createMocks(agents);
      processor = new ActionProcessor(mocks.agentManager, mocks.fileProtocol, mocks.cmuxClient, () => defaultConfig);

      await processor.processAction('agent-1', {
        action: 'delegate_to',
        role: 'backend',
        task: 'implement API',
      });

      expect(mocks.agentManager.assignTask).toHaveBeenCalledWith('backend-1', 'implement API');
      expect(mocks.agentManager.spawn).not.toHaveBeenCalled();
    });

    it('should reject delegation after MAX_DELEGATE_REPEATS', async () => {
      // Same task, same role, 3 times
      const task = 'implement API endpoint';
      await processor.processAction('agent-1', { action: 'delegate_to', role: 'backend', task });
      await processor.processAction('agent-1', { action: 'delegate_to', role: 'backend', task });
      await processor.processAction('agent-1', { action: 'delegate_to', role: 'backend', task });

      // 3rd call should be rejected (MAX_DELEGATE_REPEATS=2)
      const calls = mocks.fileProtocol.writeInbox.mock.calls;
      const lastCall = calls[calls.length - 1];
      expect(lastCall[1]).toContain('Delegation Rejected');
    });

    it('should allow delegation of different tasks to same role', async () => {
      await processor.processAction('agent-1', { action: 'delegate_to', role: 'backend', task: 'task A' });
      await processor.processAction('agent-1', { action: 'delegate_to', role: 'backend', task: 'task B' });

      // Both should succeed (different tasks)
      expect(mocks.agentManager.spawn).toHaveBeenCalledTimes(2);
    });
  });

  describe('ask action', () => {
    it('should route question to target agent inbox', () => {
      const target = makeAgent({ id: 'agent-2', name: 'expert' });
      const agents = [makeAgent(), target];
      mocks = createMocks(agents);
      processor = new ActionProcessor(mocks.agentManager, mocks.fileProtocol, mocks.cmuxClient, () => defaultConfig);

      const spy = vi.fn();
      processor.on('ask_processed', spy);

      processor.processAction('agent-1', {
        action: 'ask',
        to: 'expert',
        question: 'How does auth work?',
      });

      expect(mocks.agentManager.resumeWithMessage).toHaveBeenCalledWith(
        'agent-2',
        expect.stringContaining('Question from worker-1'),
      );
      expect(mocks.agentManager.resumeWithMessage).toHaveBeenCalledWith(
        'agent-2',
        expect.stringContaining('How does auth work?'),
      );
      expect(spy).toHaveBeenCalled();
    });

    it('should notify sender when target not found', () => {
      processor.processAction('agent-1', {
        action: 'ask',
        to: 'nonexistent',
        question: 'Hello?',
      });

      expect(mocks.fileProtocol.writeInbox).toHaveBeenCalledWith(
        'agent-1',
        expect.stringContaining('Ask Failed'),
      );
    });

    it('should warn when target is dead', () => {
      const deadAgent = makeAgent({ id: 'agent-2', name: 'dead-agent', status: 'dead' });
      const agents = [makeAgent(), deadAgent];
      mocks = createMocks(agents);
      processor = new ActionProcessor(mocks.agentManager, mocks.fileProtocol, mocks.cmuxClient, () => defaultConfig);

      processor.processAction('agent-1', {
        action: 'ask',
        to: 'dead-agent',
        question: 'Are you there?',
      });

      // Should warn the sender AND still deliver (warning via writeInbox, delivery via resumeWithMessage)
      const inboxCalls = mocks.fileProtocol.writeInbox.mock.calls;
      expect(inboxCalls.some(c => c[0] === 'agent-1' && c[1].includes('Ask Warning'))).toBe(true);
      const resumeCalls = mocks.agentManager.resumeWithMessage.mock.calls;
      expect(resumeCalls.some((c: [string, string]) => c[0] === 'agent-2' && c[1].includes('Question from'))).toBe(true);
    });

    it('should time out pending asks', async () => {
      vi.useFakeTimers();
      try {
        const target = makeAgent({ id: 'agent-2', name: 'expert' });
        const agents = [makeAgent(), target];
        mocks = createMocks(agents);
        processor = new ActionProcessor(mocks.agentManager, mocks.fileProtocol, mocks.cmuxClient, () => defaultConfig);

        processor.processAction('agent-1', {
          action: 'ask',
          to: 'expert',
          question: 'How does auth work?',
        });

        // Fast-forward past timeout (5 minutes)
        vi.advanceTimersByTime(5 * 60 * 1000 + 100);

        const inboxCalls = mocks.fileProtocol.writeInbox.mock.calls;
        expect(inboxCalls.some(c => c[0] === 'agent-1' && c[1].includes('Ask Timeout'))).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('answer action', () => {
    it('should route answer to questioner inbox', () => {
      const questioner = makeAgent({ id: 'agent-2', name: 'questioner' });
      const agents = [makeAgent(), questioner];
      mocks = createMocks(agents);
      processor = new ActionProcessor(mocks.agentManager, mocks.fileProtocol, mocks.cmuxClient, () => defaultConfig);

      processor.processAction('agent-1', {
        action: 'answer',
        to: 'questioner',
        question: 'How does auth work?',
        answer: 'It uses JWT tokens.',
      });

      expect(mocks.agentManager.resumeWithMessage).toHaveBeenCalledWith(
        'agent-2',
        expect.stringContaining('Answer from worker-1'),
      );
      expect(mocks.agentManager.resumeWithMessage).toHaveBeenCalledWith(
        'agent-2',
        expect.stringContaining('It uses JWT tokens.'),
      );
    });

    it('should cancel ask timeout when answer is received', () => {
      vi.useFakeTimers();
      try {
        const target = makeAgent({ id: 'agent-2', name: 'expert' });
        const agents = [makeAgent(), target];
        mocks = createMocks(agents);
        processor = new ActionProcessor(mocks.agentManager, mocks.fileProtocol, mocks.cmuxClient, () => defaultConfig);

        // agent-1 asks expert
        processor.processAction('agent-1', {
          action: 'ask',
          to: 'expert',
          question: 'How does auth work?',
        });

        // expert answers
        processor.processAction('agent-2', {
          action: 'answer',
          to: 'worker-1',
          question: 'How does auth work?',
          answer: 'JWT tokens',
        });

        // Fast-forward — should NOT get timeout
        vi.advanceTimersByTime(5 * 60 * 1000 + 100);

        const inboxCalls = mocks.fileProtocol.writeInbox.mock.calls;
        expect(inboxCalls.some(c => c[0] === 'agent-1' && c[1].includes('Ask Timeout'))).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('should notify sender when target not found', () => {
      processor.processAction('agent-1', {
        action: 'answer',
        to: 'nonexistent',
        question: 'Q',
        answer: 'A',
      });

      expect(mocks.fileProtocol.writeInbox).toHaveBeenCalledWith(
        'agent-1',
        expect.stringContaining('Answer Failed'),
      );
    });
  });

  describe('report_to_pm action', () => {
    it('should send cmux notification for blocked reports', async () => {
      await processor.processAction('agent-1', {
        action: 'report_to_pm',
        type: 'blocked',
        summary: 'Cannot access database',
      });

      expect(mocks.cmuxClient.notify).toHaveBeenCalledWith(
        'worker-1: blocked',
        'Cannot access database',
      );
    });

    it('should not send notification for progress reports', async () => {
      await processor.processAction('agent-1', {
        action: 'report_to_pm',
        type: 'progress',
        summary: '50% done',
      });

      expect(mocks.cmuxClient.notify).not.toHaveBeenCalled();
    });

    it('should forward to parent if parentId exists', async () => {
      const child = makeAgent({ id: 'child-1', name: 'child', parentId: 'agent-1' });
      const parent = makeAgent({ id: 'agent-1', name: 'parent', status: 'working' });
      const agents = [parent, child];
      mocks = createMocks(agents);
      processor = new ActionProcessor(mocks.agentManager, mocks.fileProtocol, mocks.cmuxClient, () => defaultConfig);

      await processor.processAction('child-1', {
        action: 'report_to_pm',
        type: 'progress',
        summary: 'Making progress',
      });

      expect(mocks.agentManager.resumeWithMessage).toHaveBeenCalledWith(
        'agent-1',
        expect.stringContaining('Report from child [progress]'),
      );
    });
  });

  describe('message action', () => {
    it('should route message to target agent inbox', () => {
      const target = makeAgent({ id: 'agent-2', name: 'colleague' });
      const agents = [makeAgent(), target];
      mocks = createMocks(agents);
      processor = new ActionProcessor(mocks.agentManager, mocks.fileProtocol, mocks.cmuxClient, () => defaultConfig);

      processor.processAction('agent-1', {
        action: 'message',
        to: 'colleague',
        content: 'FYI: API schema changed',
      });

      expect(mocks.agentManager.resumeWithMessage).toHaveBeenCalledWith(
        'agent-2',
        expect.stringContaining('Message from worker-1'),
      );
      expect(mocks.agentManager.resumeWithMessage).toHaveBeenCalledWith(
        'agent-2',
        expect.stringContaining('API schema changed'),
      );
    });

    it('should notify sender when target not found', () => {
      processor.processAction('agent-1', {
        action: 'message',
        to: 'nonexistent',
        content: 'Hello',
      });

      expect(mocks.fileProtocol.writeInbox).toHaveBeenCalledWith(
        'agent-1',
        expect.stringContaining('Message Failed'),
      );
    });

    it('should warn when target is dead', () => {
      const deadAgent = makeAgent({ id: 'agent-2', name: 'dead-one', status: 'dead' });
      const agents = [makeAgent(), deadAgent];
      mocks = createMocks(agents);
      processor = new ActionProcessor(mocks.agentManager, mocks.fileProtocol, mocks.cmuxClient, () => defaultConfig);

      processor.processAction('agent-1', {
        action: 'message',
        to: 'dead-one',
        content: 'Hello',
      });

      const inboxCalls = mocks.fileProtocol.writeInbox.mock.calls;
      expect(inboxCalls.some(c => c[0] === 'agent-1' && c[1].includes('Message Warning'))).toBe(true);
      const resumeCalls = mocks.agentManager.resumeWithMessage.mock.calls;
      expect(resumeCalls.some((c: [string, string]) => c[0] === 'agent-2' && c[1].includes('Message from'))).toBe(true);
    });
  });

  describe('processAction return value', () => {
    it('should return true for handled actions', async () => {
      expect(await processor.processAction('agent-1', { action: 'spawn', name: 'x', cli: 'claude', prompt: 'y' })).toBe(true);
    });

    it('should return false for unhandled actions', async () => {
      expect(await processor.processAction('agent-1', { action: 'done', summary: 'ok' })).toBe(false);
      expect(await processor.processAction('agent-1', { action: 'error', message: 'fail' })).toBe(false);
      expect(await processor.processAction('agent-1', { action: 'status', text: 'working' })).toBe(false);
    });
  });

  describe('workflow review loop', () => {
    const workflowConfig: ProjectConfig = {
      ...defaultConfig,
      agents: {
        ...defaultConfig.agents,
        roles: [
          ...defaultConfig.agents.roles,
          { id: 'reviewer', cli: 'claude' },
        ],
      },
      workflows: {
        'dev-cycle': {
          steps: [
            {
              role: 'developer',
              parallel: false,
              review: {
                role: 'reviewer',
                max_iterations: 3,
                retry_on: 'changes_requested',
                pass_on: 'LGTM',
              },
            },
          ],
        },
      },
    };

    it('should auto-spawn reviewer when developer with workflow writes done', async () => {
      const developer = makeAgent({ id: 'dev-1', name: 'developer-1', roleId: 'developer' });
      const mocks2 = createMocks([developer]);
      const proc = new ActionProcessor(mocks2.agentManager, mocks2.fileProtocol, mocks2.cmuxClient, () => workflowConfig);

      const spy = vi.fn();
      proc.on('review_started', spy);

      const handled = await proc.processAction('dev-1', { action: 'done', summary: 'Implemented feature X' });

      expect(handled).toBe(true);
      expect(proc.shouldDeferTaskCompletion('dev-1')).toBe(true);
      expect(mocks2.agentManager.spawn).toHaveBeenCalledWith(
        expect.stringContaining('reviewer-'),
        'claude',
        expect.stringContaining('Implemented feature X'),
        '/tmp/project',
        expect.objectContaining({ roleId: 'reviewer', parentId: 'dev-1' }),
      );
      expect(mocks2.fileProtocol.writeInbox).toHaveBeenCalledWith(
        'dev-1',
        expect.stringContaining('Review Requested'),
      );
      expect(spy).toHaveBeenCalledWith(expect.objectContaining({ developerAgentId: 'dev-1', iteration: 1 }));

      proc.destroy();
    });

    it('should emit review_bypassed when reviewer spawn fails', async () => {
      const developer = makeAgent({ id: 'dev-1', name: 'developer-1', roleId: 'developer' });
      const mocks2 = createMocks([developer]);
      mocks2.agentManager.spawn.mockRejectedValueOnce(new Error('cmux unavailable'));
      const proc = new ActionProcessor(mocks2.agentManager, mocks2.fileProtocol, mocks2.cmuxClient, () => workflowConfig);

      const spy = vi.fn();
      proc.on('review_bypassed', spy);

      const handled = await proc.processAction('dev-1', { action: 'done', summary: 'Implemented feature X' });

      expect(handled).toBe(false);
      expect(proc.shouldDeferTaskCompletion('dev-1')).toBe(false);
      expect(spy).toHaveBeenCalledWith(expect.objectContaining({
        developerAgentId: 'dev-1',
        summary: 'Implemented feature X',
      }));

      proc.destroy();
    });

    it('should resume developer with feedback when reviewer requests changes', async () => {
      const developer = makeAgent({ id: 'dev-1', name: 'developer-1', roleId: 'developer' });
      const mocks2 = createMocks([developer]);
      const proc = new ActionProcessor(mocks2.agentManager, mocks2.fileProtocol, mocks2.cmuxClient, () => workflowConfig);

      await proc.processAction('dev-1', { action: 'done', summary: 'Implemented feature X' });
      const reviewerId = mocks2.spawnedAgents[0].id;

      const spy = vi.fn();
      proc.on('review_changes_requested', spy);

      await proc.processAction(reviewerId, { action: 'done', summary: 'changes_requested: add tests' });

      expect(mocks2.agentManager.resumeWithMessage).toHaveBeenCalledWith(
        'dev-1',
        expect.stringContaining('Changes Requested'),
      );
      expect(spy).toHaveBeenCalledWith(expect.objectContaining({ developerAgentId: 'dev-1', reviewerAgentId: reviewerId }));

      proc.destroy();
    });

    it('should notify developer and emit review_approved when reviewer approves with LGTM', async () => {
      const developer = makeAgent({ id: 'dev-1', name: 'developer-1', roleId: 'developer' });
      const mocks2 = createMocks([developer]);
      const proc = new ActionProcessor(mocks2.agentManager, mocks2.fileProtocol, mocks2.cmuxClient, () => workflowConfig);

      await proc.processAction('dev-1', { action: 'done', summary: 'Implemented feature X' });
      const reviewerId = mocks2.spawnedAgents[0].id;

      const spy = vi.fn();
      proc.on('review_approved', spy);

      const reviewerHandled = await proc.processAction(reviewerId, { action: 'done', summary: 'LGTM: looks good' });

      expect(reviewerHandled).toBe(false); // reviewer done propagates normally
      expect(mocks2.agentManager.resumeWithMessage).toHaveBeenCalledWith(
        'dev-1',
        expect.stringContaining('Review Approved'),
      );
      expect(spy).toHaveBeenCalledWith(expect.objectContaining({ developerAgentId: 'dev-1' }));

      proc.destroy();
    });

    it('should not spawn reviewer when agent has no matching workflow role', async () => {
      // agent-1 has no roleId, defaultConfig has no workflows
      const handled = await processor.processAction('agent-1', { action: 'done', summary: 'done' });
      expect(handled).toBe(false);
      expect(mocks.agentManager.spawn).not.toHaveBeenCalled();
    });

    it('should stop review loop after max_iterations and let done through', async () => {
      const developer = makeAgent({ id: 'dev-1', name: 'developer-1', roleId: 'developer' });
      const mocks2 = createMocks([developer]);
      const oneIterConfig: ProjectConfig = {
        ...workflowConfig,
        workflows: {
          'dev-cycle': {
            steps: [{
              role: 'developer',
              parallel: false,
              review: { role: 'reviewer', max_iterations: 1, retry_on: 'changes_requested', pass_on: 'LGTM' },
            }],
          },
        },
      };
      const proc = new ActionProcessor(mocks2.agentManager, mocks2.fileProtocol, mocks2.cmuxClient, () => oneIterConfig);

      // Iteration 1: developer done → reviewer spawned
      await proc.processAction('dev-1', { action: 'done', summary: 'v1' });
      const reviewerId1 = mocks2.spawnedAgents[0].id;

      // Reviewer requests changes → developer resumed
      await proc.processAction(reviewerId1, { action: 'done', summary: 'changes_requested: fix bug' });

      // Developer done again → max_iterations=1 already used, let it through
      const handled = await proc.processAction('dev-1', { action: 'done', summary: 'v2 fixed' });
      expect(handled).toBe(false);
      expect(mocks2.agentManager.spawn).toHaveBeenCalledTimes(1); // only one reviewer spawned

      proc.destroy();
    });
  });
});

import assert from 'assert/strict';

process.env.FEISHU_APP_ID = process.env.FEISHU_APP_ID || 'test-app-id';
process.env.FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET || 'test-app-secret';

import { createAgentRuntimeStatus } from '../src/agent/runtime-status';
import type { ChatAgent, OnErrorCallback, OnResponseCallback, SendMessageOptions } from '../src/agent/types';
import type { CreateAgentOptions } from '../src/agent/factory';

const {
  ChatManager,
} = require('../src/bot/chat-manager') as typeof import('../src/bot/chat-manager');

type TimerEntry = {
  callback: () => void;
  delayMs: number;
  cleared: boolean;
};

class FakeAgent implements ChatAgent {
  responseCallback: OnResponseCallback | null = null;
  errorCallback: OnErrorCallback | null = null;
  destroyCalls = 0;
  running = false;
  alive = true;
  sessionId: string | undefined;

  constructor(
    private readonly agentId: string,
    private readonly cwd: string,
    sessionId: string | undefined,
    private readonly now: () => number,
  ) {
    this.sessionId = sessionId ?? `${agentId}-thread`;
  }

  async sendMessage(_text: string, _options?: SendMessageOptions): Promise<void> {
    return undefined;
  }

  interrupt(): boolean {
    return false;
  }

  async destroy(): Promise<void> {
    this.destroyCalls += 1;
    this.alive = false;
  }

  getAgentId(): string {
    return this.agentId;
  }

  getCwd(): string {
    return this.cwd;
  }

  getSessionId(): string | undefined {
    return this.sessionId;
  }

  isInitialized(): boolean {
    return true;
  }

  isAlive(): boolean {
    return this.alive;
  }

  isRunning(): boolean {
    return this.running;
  }

  onResponse(callback: OnResponseCallback): void {
    this.responseCallback = callback;
  }

  onError(callback: OnErrorCallback): void {
    this.errorCallback = callback;
  }

  getStartTime(): number {
    return this.now();
  }

  getRuntimeStatus() {
    return createAgentRuntimeStatus({
      phase: this.running ? 'running' : 'idle',
      detail: this.running ? 'synthetic running' : 'synthetic idle',
      isTurnInProgress: this.running,
      lastActivityAt: this.now(),
    });
  }
}

function createHarness(defaultProvider: 'claude' | 'codex' = 'codex') {
  let nowMs = 1_000;
  const timers: TimerEntry[] = [];
  const createdAgents: FakeAgent[] = [];
  const capturedOptions: CreateAgentOptions[] = [];

  const manager = new ChatManager({
    defaultCwd: 'C:\\work\\repo-alpha',
    defaultProvider,
    agentIdleTtlMs: 30_000,
    now: () => nowMs,
    sessionDecisionNotifier: async () => undefined,
    setTimeoutFn: (callback, delayMs) => {
      const entry = { callback, delayMs, cleared: false };
      timers.push(entry);
      return entry as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeoutFn: (handle) => {
      (handle as unknown as TimerEntry).cleared = true;
    },
    agentFactory: (options) => {
      capturedOptions.push(options);
      const agent = new FakeAgent(
        `fake-${createdAgents.length + 1}`,
        options.cwd,
        options.resumeSessionId,
        () => nowMs,
      );
      createdAgents.push(agent);
      return agent;
    },
  });

  return {
    manager,
    timers,
    createdAgents,
    capturedOptions,
    advance(ms: number): void {
      nowMs += ms;
    },
    async fireTimer(index = timers.length - 1): Promise<void> {
      timers[index].callback();
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

async function main(): Promise<void> {
  {
    const harness = createHarness();

    await harness.manager.sendMessage('oc_idle', 'hello');
    assert.equal(harness.createdAgents.length, 1);
    assert.equal(harness.timers.length, 1);
    assert.equal(harness.timers[0].delayMs, 30_000);

    harness.advance(30_000);
    await harness.fireTimer();

    assert.equal(harness.createdAgents[0].destroyCalls, 1);
    assert.match(harness.manager.getSessionInfo('oc_idle'), /当前没有活跃会话/);

    await harness.manager.sendMessage('oc_idle', 'after idle');
    assert.equal(harness.createdAgents.length, 2);
    assert.equal(harness.capturedOptions[1].resumeSessionId, undefined);
  }

  {
    const harness = createHarness();

    await harness.manager.sendMessage('oc_idle_continue', 'hello');
    harness.advance(30_000);
    await harness.fireTimer();

    await harness.manager.sendMessage('oc_idle_continue', '继续刚才的');

    assert.equal(harness.createdAgents.length, 2);
    assert.equal(harness.capturedOptions[1].resumeSessionId, 'fake-1-thread');
  }

  {
    const harness = createHarness();

    await harness.manager.sendMessage('oc_running', 'hello');
    harness.createdAgents[0].running = true;

    await harness.fireTimer();

    assert.equal(harness.createdAgents[0].destroyCalls, 0);
    assert.equal(harness.createdAgents.length, 1);
    assert.equal(harness.timers.length, 2, 'running agent should be checked again later');

    harness.createdAgents[0].running = false;
    await harness.fireTimer();

    assert.equal(harness.createdAgents[0].destroyCalls, 1);
  }

  {
    const harness = createHarness();

    await harness.manager.sendMessage('oc_reuse', 'first');
    await harness.manager.sendMessage('oc_reuse', 'second');

    assert.equal(harness.createdAgents.length, 1);
    assert.equal(harness.timers.length, 2);
    assert.equal(harness.timers[0].cleared, true);
    assert.equal(harness.timers[1].cleared, false);
  }

  {
    const harness = createHarness('claude');

    await harness.manager.sendMessage('oc_claude', 'hello');

    assert.equal(harness.createdAgents.length, 1);
    assert.equal(harness.timers.length, 0, 'non-Codex agents should not use idle reclaim');
    assert.equal(harness.createdAgents[0].destroyCalls, 0);
  }

  console.log('chat-manager-idle-reclaim.test.ts passed');
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

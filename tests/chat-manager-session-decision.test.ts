import assert from 'node:assert/strict';

process.env.FEISHU_APP_ID = process.env.FEISHU_APP_ID || 'test-app-id';
process.env.FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET || 'test-app-secret';

import { createAgentRuntimeStatus } from '../src/agent/runtime-status';
import type { ChatAgent, OnErrorCallback, OnResponseCallback, SendMessageOptions } from '../src/agent/types';
import type { CreateAgentOptions } from '../src/agent/factory';

const {
  ChatManager,
} = require('../src/bot/chat-manager') as typeof import('../src/bot/chat-manager');

class FakeAgent implements ChatAgent {
  responseCallback: OnResponseCallback | null = null;
  errorCallback: OnErrorCallback | null = null;
  destroyCalls = 0;
  alive = true;
  sentMessages: string[] = [];

  constructor(
    private readonly agentId: string,
    private readonly cwd: string,
    private readonly sessionId: string | undefined,
    private readonly now: () => number,
  ) {}

  async sendMessage(text: string, _options?: SendMessageOptions): Promise<void> {
    this.sentMessages.push(text);
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
      phase: 'idle',
      detail: 'synthetic idle',
      lastActivityAt: this.now(),
    });
  }
}

function at(iso: string): number {
  return new Date(iso).getTime();
}

function createHarness(initialNow: number) {
  let nowMs = initialNow;
  const notices: string[] = [];
  const capturedOptions: CreateAgentOptions[] = [];
  const createdAgents: FakeAgent[] = [];

  const manager = new ChatManager({
    defaultCwd: 'C:\\work\\repo-alpha',
    defaultProvider: 'codex',
    agentIdleTtlMs: 60_000,
    sessionDayCutoffHour: 5,
    now: () => nowMs,
    sessionDecisionNotifier: async (_chatId, text) => {
      notices.push(text);
    },
    agentFactory: (options) => {
      capturedOptions.push(options);
      const agent = new FakeAgent(
        `fake-${createdAgents.length + 1}`,
        options.cwd,
        options.resumeSessionId ?? `new-session-${createdAgents.length + 1}`,
        () => nowMs,
      );
      createdAgents.push(agent);
      return agent;
    },
  });

  return {
    manager,
    notices,
    capturedOptions,
    createdAgents,
    setNow(value: number): void {
      nowMs = value;
    },
    seedChat(lastActiveAt: number, sessionId = 'previous-session'): void {
      (manager as any).chats.set('oc_session', {
        cwd: 'C:\\work\\repo-alpha',
        provider: 'codex',
        sessionId,
        sessionNotified: false,
        lastActiveAt,
      });
    },
  };
}

async function main(): Promise<void> {
  {
    const harness = createHarness(at('2026-05-16T00:30:00+08:00'));
    harness.seedChat(at('2026-05-15T23:30:00+08:00'));

    await harness.manager.sendMessage('oc_session', '这个怎么处理');

    assert.equal(harness.capturedOptions[0].resumeSessionId, 'previous-session');
    assert.deepEqual(harness.notices, []);
  }

  {
    const harness = createHarness(at('2026-05-16T05:30:00+08:00'));
    harness.seedChat(at('2026-05-15T23:30:00+08:00'));

    await harness.manager.sendMessage('oc_session', '这个怎么处理');

    assert.equal(harness.capturedOptions[0].resumeSessionId, undefined);
    assert.deepEqual(harness.notices, ['已跨作息日，未检测到继续意图，已新开会话。']);
  }

  {
    const harness = createHarness(at('2026-05-16T05:30:00+08:00'));

    await harness.manager.sendMessage('oc_session', '继续');

    assert.equal(harness.capturedOptions[0].resumeSessionId, undefined);
    assert.deepEqual(harness.notices, ['检测到继续意图，但当前没有可延续会话，已新开会话。']);
  }

  {
    const harness = createHarness(at('2026-05-16T05:30:00+08:00'));
    harness.seedChat(at('2026-05-15T23:30:00+08:00'));

    await harness.manager.sendMessage('oc_session', '继续昨天那个');

    assert.equal(harness.capturedOptions[0].resumeSessionId, 'previous-session');
    assert.deepEqual(harness.notices, ['检测到继续意图，沿用上一个会话。']);
  }

  {
    const harness = createHarness(at('2026-05-16T00:30:00+08:00'));
    harness.seedChat(at('2026-05-15T23:30:00+08:00'));

    await harness.manager.sendMessage('oc_session', '换个话题');

    assert.equal(harness.capturedOptions[0].resumeSessionId, undefined);
    assert.deepEqual(harness.notices, ['检测到新开意图，已新开会话。']);
  }

  {
    const harness = createHarness(at('2026-05-16T05:30:00+08:00'));
    harness.seedChat(at('2026-05-15T23:30:00+08:00'));

    await harness.manager.sendMessage('oc_session', '先开一个 agent');
    const firstAgent = harness.createdAgents[0];
    harness.setNow(at('2026-05-16T05:31:00+08:00'));
    await harness.manager.sendMessage('oc_session', '新开');

    assert.equal(firstAgent.destroyCalls, 1);
    assert.equal(harness.capturedOptions[1].resumeSessionId, undefined);
  }

  console.log('chat-manager-session-decision.test.ts passed');
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

import assert from 'assert/strict';
import type { AgentRuntimeStatus } from '../src/agent/runtime-status';

process.env.FEISHU_APP_ID = process.env.FEISHU_APP_ID || 'test-app-id';
process.env.FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET || 'test-app-secret';

const { ChatManager } = require('../src/bot/chat-manager') as typeof import('../src/bot/chat-manager');
const messageService = (require('../src/services/message.service') as typeof import('../src/services/message.service')).default;

const WAITING_STATUS_LINE = '\u5f53\u524d\u72b6\u6001: \u7b49\u5f85\u4e2d';
const WAITING_DETAIL_LINE =
  '\u72b6\u6001\u8bf4\u660e: \u7b49\u5f85\u5de5\u5177 exec_command \u6267\u884c\u7ed3\u679c';
const RUNNING_DECISION_LINE =
  '\u6267\u884c\u5224\u65ad: \u4ecd\u6709\u4efb\u52a1\u5728\u6267\u884c\u6216\u7b49\u5f85';
const IDLE_STATUS_LINE = '\u5f53\u524d\u72b6\u6001: \u7a7a\u95f2';
const IDLE_DETAIL_LINE = '\u72b6\u6001\u8bf4\u660e: \u672c\u8f6e\u5df2\u5b8c\u6210';
const IDLE_DECISION_LINE =
  '\u6267\u884c\u5224\u65ad: \u5f53\u524d\u6ca1\u6709\u6267\u884c\u4e2d\u7684\u4efb\u52a1';

async function main(): Promise<void> {
  let finishSend!: () => void;
  const originalSendTextMessage = messageService.sendTextMessage.bind(messageService);
  let status: AgentRuntimeStatus = {
    phase: 'idle',
    detail: '\u7b49\u5f85\u65b0\u4efb\u52a1',
    updatedAt: Date.now(),
    lastActivityAt: null,
    activityCount: 0,
    isTurnInProgress: false,
  };

  const fakeAgent = {
    async sendMessage(): Promise<void> {
      status = {
        phase: 'waiting',
        detail: '\u7b49\u5f85\u5de5\u5177 exec_command \u6267\u884c\u7ed3\u679c',
        updatedAt: Date.now(),
        lastActivityAt: null,
        activityCount: 4,
        isTurnInProgress: true,
      };
      await new Promise<void>((resolve) => {
        finishSend = () => {
          status = {
            phase: 'idle',
            detail: '\u672c\u8f6e\u5df2\u5b8c\u6210',
            updatedAt: Date.now(),
            lastActivityAt: Date.now(),
            activityCount: 5,
            isTurnInProgress: false,
          };
          resolve();
        };
      });
    },
    interrupt(): boolean {
      return true;
    },
    async destroy(): Promise<void> {},
    getAgentId(): string {
      return 'fake-agent';
    },
    getCwd(): string {
      return 'C:\\work\\repo-alpha';
    },
    getSessionId(): string | undefined {
      return 'session-alpha-1234567890';
    },
    isInitialized(): boolean {
      return true;
    },
    isAlive(): boolean {
      return true;
    },
    onResponse(): void {},
    onError(): void {},
    getStartTime(): number {
      return Date.now() - 30_000;
    },
    getRuntimeStatus() {
      return { ...status };
    },
  };

  const manager = new ChatManager({
    defaultCwd: 'C:\\work',
    defaultProvider: 'codex',
    agentFactory: () => fakeAgent,
  });

  try {
    messageService.sendTextMessage = (async () => {}) as typeof messageService.sendTextMessage;

    const sendPromise = manager.sendMessage('oc_status_report', 'first task');
    await new Promise(resolve => setTimeout(resolve, 0));

    const runningInfo = manager.getDetailedSessionInfo('oc_status_report');
    assert.ok(runningInfo.includes(WAITING_STATUS_LINE), runningInfo);
    assert.ok(runningInfo.includes(WAITING_DETAIL_LINE), runningInfo);
    assert.ok(runningInfo.includes(RUNNING_DECISION_LINE), runningInfo);

    finishSend();
    await sendPromise;

    const idleInfo = manager.getDetailedSessionInfo('oc_status_report');
    assert.ok(idleInfo.includes(IDLE_STATUS_LINE), idleInfo);
    assert.ok(idleInfo.includes(IDLE_DETAIL_LINE), idleInfo);
    assert.ok(idleInfo.includes(IDLE_DECISION_LINE), idleInfo);
  } finally {
    messageService.sendTextMessage = originalSendTextMessage as typeof messageService.sendTextMessage;
  }

  console.log('session-status-report.test.ts passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

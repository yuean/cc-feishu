import assert from 'assert/strict';

process.env.FEISHU_APP_ID = process.env.FEISHU_APP_ID || 'test-app-id';
process.env.FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET || 'test-app-secret';

import { ChatWorkloadQueue } from '../src/bot/chat-workload-queue';
import type { ActivityEvent } from '../src/agent/types';

interface TestTask {
  chatId: string;
  messageId: string;
  text: string;
  release: Promise<void>;
}

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolvePromise!: () => void;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

async function delay(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await delay(5);
  }
  throw new Error(`${label} was not observed`);
}

function createQueue(options: {
  notices: string[];
  onProcess?: (event: ActivityEvent) => void;
  notifier?: (chatId: string, text: string) => Promise<void>;
}): ChatWorkloadQueue<TestTask> {
  return new ChatWorkloadQueue<TestTask>({
    describeTask: task => ({
      chatId: task.chatId,
      messageId: task.messageId,
      senderId: 'ou_test',
      provider: 'codex',
      messageType: 'text',
      textLength: task.text.length,
      imageCount: 0,
      enqueuedAt: Date.now(),
    }),
    processTask: async (task, context) => {
      const event: ActivityEvent = {
        phase: 'turn_running',
        reason: `processing ${task.text}`,
        method: 'item/completed',
        turnId: 'turn-long-notice',
      };
      context.onActivity(event);
      options.onProcess?.(event);
      await task.release;
    },
    longRunningNotifier: options.notifier ?? (async (_chatId, text) => {
      options.notices.push(text);
    }),
    longTaskNoticeFirstMs: 30,
    longTaskNoticeIntervalMs: 30,
    longTaskNoticeMaxCount: 2,
  });
}

async function runLongRunningNoticeTest(): Promise<void> {
  const notices: string[] = [];
  const release = createDeferred();
  const queue = createQueue({ notices });

  queue.enqueue({
    chatId: 'oc_long_notice',
    messageId: 'om_long_notice_1',
    text: '长任务',
    release: release.promise,
  });

  await waitFor(() => notices.length === 1, 'first long-running notice');
  assert.match(notices[0], /这条任务还在处理中，我会继续跟进/);
  assert.match(notices[0], /已处理时长: /);
  assert.match(notices[0], /当前阶段: 正在处理/);
  assert.doesNotMatch(notices[0], /item\/completed|Turn:|最新进展:|距上次进展/);
  assert.match(notices[0], /可发送 \/stat 查看详情，或发送 \/stop 中断任务/);

  await waitFor(() => notices.length === 2, 'second long-running notice');
  await delay(60);
  assert.equal(notices.length, 2, 'notice count should stop at max count');

  release.resolve();
  await queue.stop();
}

async function runNoNoticeAfterCompletionTest(): Promise<void> {
  const notices: string[] = [];
  const release = createDeferred();
  const queue = createQueue({ notices });

  queue.enqueue({
    chatId: 'oc_long_notice_done',
    messageId: 'om_long_notice_done_1',
    text: '短任务',
    release: release.promise,
  });

  release.resolve();
  await queue.stop();
  await delay(60);

  assert.equal(notices.length, 0, 'completed task should cancel pending long-running notices');
}

async function runNotifierFailureDoesNotBlockTaskTest(): Promise<void> {
  const notices: string[] = [];
  const release = createDeferred();
  const queue = createQueue({
    notices,
    notifier: async () => {
      throw new Error('synthetic notifier failure');
    },
  });

  queue.enqueue({
    chatId: 'oc_long_notice_failure',
    messageId: 'om_long_notice_failure_1',
    text: '通知失败任务',
    release: release.promise,
  });

  await delay(50);
  release.resolve();
  await queue.stop();

  assert.equal(notices.length, 0);
}

async function main(): Promise<void> {
  await runLongRunningNoticeTest();
  await runNoNoticeAfterCompletionTest();
  await runNotifierFailureDoesNotBlockTaskTest();
  console.log('chat-workload-queue-long-notice.test.ts passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

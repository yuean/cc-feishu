import assert from 'assert/strict';

process.env.FEISHU_APP_ID = process.env.FEISHU_APP_ID || 'test-app-id';
process.env.FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET || 'test-app-secret';
process.env.FEISHU_ALLOWED_OPEN_IDS = 'ou_admin,ou_ops';
process.env.MESSAGE_IDLE_TIMEOUT_MS = '50';

const { handleMessage } = require('../src/handlers/message.handler') as typeof import('../src/handlers/message.handler');
const { chatManager } = require('../src/bot/chat-manager') as typeof import('../src/bot/chat-manager');
const messageService = (require('../src/services/message.service') as typeof import('../src/services/message.service')).default;

interface MessageEvent {
  sender: {
    sender_id: {
      open_id: string;
    };
    sender_type: string;
  };
  message: {
    message_id: string;
    message_type: string;
    content: string;
    chat_id: string;
    chat_type?: string;
  };
}

function createTextEvent(messageId: string, text: string): MessageEvent {
  return {
    sender: {
      sender_id: {
        open_id: 'ou_admin',
      },
      sender_type: 'user',
    },
    message: {
      message_id: messageId,
      message_type: 'text',
      content: JSON.stringify({ text }),
      chat_id: 'oc_timeout_notify',
      chat_type: 'p2p_chat',
    },
  };
}

async function main(): Promise<void> {
  const originalSendTextMessage = messageService.sendTextMessage.bind(messageService);
  const originalAddReaction = messageService.addReaction.bind(messageService);
  const originalRemoveReaction = messageService.removeReaction.bind(messageService);
  const originalSendMessage = chatManager.sendMessage.bind(chatManager);
  const originalInterrupt = chatManager.interrupt.bind(chatManager);
  const originalReset = chatManager.reset.bind(chatManager);
  const originalGetRuntimeStatus = chatManager.getRuntimeStatus.bind(chatManager);

  try {
    let sentText = '';
    let interruptCalled = false;
    let resetCalled = false;

    messageService.sendTextMessage = (async (_chatId: string, text: string) => {
      sentText = text;
    }) as typeof messageService.sendTextMessage;
    messageService.addReaction = (async () => null) as typeof messageService.addReaction;
    messageService.removeReaction = (async () => {}) as typeof messageService.removeReaction;
    chatManager.sendMessage = (async () => new Promise<void>(() => {})) as typeof chatManager.sendMessage;
    chatManager.interrupt = (async () => {
      interruptCalled = true;
      return 'success';
    }) as typeof chatManager.interrupt;
    chatManager.reset = (async () => {
      resetCalled = true;
      return 'C:\\work\\reset-after-timeout';
    }) as typeof chatManager.reset;
    chatManager.getRuntimeStatus = (() => ({
      phase: 'waiting',
      detail: '等待工具 exec_command 执行结果',
      updatedAt: Date.now(),
      lastActivityAt: null,
      activityCount: 3,
      isTurnInProgress: true,
    })) as typeof chatManager.getRuntimeStatus;

    const timeoutPromise = handleMessage(createTextEvent('om_timeout_notify', '继续处理') as never);
    await new Promise(resolve => setTimeout(resolve, 200));

    const expectedTimeoutSeconds = Math.round(Number(process.env.MESSAGE_IDLE_TIMEOUT_MS || '300000') / 1000);

    assert.equal(
      sentText,
      [
        `消息处理超过 ${expectedTimeoutSeconds} 秒未观察到新进展，当前不会自动终止会话。`,
        '当前状态: 等待中',
        '状态说明: 等待工具 exec_command 执行结果',
        '最近活动: 暂无活动记录',
        '执行判断: 仍有任务在执行或等待',
        '后续消息会继续排队。',
        '可发送 /stat 查看详细状态；如果确认已经空闲，再考虑使用 /stop 或 /new。',
      ].join('\n'),
    );
    assert.equal(interruptCalled, false, 'timeout should not interrupt the active session automatically');
    assert.equal(resetCalled, false, 'timeout should not reset the active session automatically');

    timeoutPromise.catch(() => {});
    console.log('message-timeout-action.test.ts passed');
  } finally {
    messageService.sendTextMessage = originalSendTextMessage as typeof messageService.sendTextMessage;
    messageService.addReaction = originalAddReaction as typeof messageService.addReaction;
    messageService.removeReaction = originalRemoveReaction as typeof messageService.removeReaction;
    chatManager.sendMessage = originalSendMessage as typeof chatManager.sendMessage;
    chatManager.interrupt = originalInterrupt as typeof chatManager.interrupt;
    chatManager.reset = originalReset as typeof chatManager.reset;
    chatManager.getRuntimeStatus = originalGetRuntimeStatus as typeof chatManager.getRuntimeStatus;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

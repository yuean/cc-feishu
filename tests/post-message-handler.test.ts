import assert from 'assert/strict';

process.env.FEISHU_APP_ID = process.env.FEISHU_APP_ID || 'test-app-id';
process.env.FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET || 'test-app-secret';
process.env.FEISHU_ALLOWED_OPEN_IDS = 'ou_admin';
process.env.AGENT_PROVIDER = process.env.AGENT_PROVIDER || 'codex';

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
    chat_type: string;
  };
}

function createPostEvent(messageId: string, chatId: string, chatType: string, content: unknown): MessageEvent {
  return {
    sender: {
      sender_id: {
        open_id: 'ou_admin',
      },
      sender_type: 'user',
    },
    message: {
      message_id: messageId,
      message_type: 'post',
      content: JSON.stringify(content),
      chat_id: chatId,
      chat_type: chatType,
    },
  };
}

interface CapturedSend {
  chatId: string;
  text: string;
  imagePaths?: string[];
  onActivity?: unknown;
}

async function waitWithTimeout(promise: Promise<void>, label: string): Promise<void> {
  await Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`${label} timed out`)), 1000);
    }),
  ]);
}

async function main(): Promise<void> {
  const originalDownloadMessageImage = messageService.downloadMessageImage;
  const originalAddReaction = messageService.addReaction;
  const originalRemoveReaction = messageService.removeReaction;
  const originalSendTextMessage = messageService.sendTextMessage;
  const originalSendMessage = chatManager.sendMessage;

  try {
    const downloadCalls: Array<{ messageId: string; imageKey: string }> = [];
    const textMessages: string[] = [];
    const removedReactions: string[] = [];

    messageService.downloadMessageImage = async (messageId: string, imageKey: string): Promise<string> => {
      downloadCalls.push({ messageId, imageKey });
      return `C:\\tmp\\${imageKey}.png`;
    };
    messageService.addReaction = (async () => 'reaction-1') as typeof messageService.addReaction;
    messageService.removeReaction = (async (_messageId: string, reactionId: string) => {
      removedReactions.push(reactionId);
      resolveRemoved?.();
    }) as typeof messageService.removeReaction;
    messageService.sendTextMessage = (async (_chatId: string, text: string) => {
      textMessages.push(text);
    }) as typeof messageService.sendTextMessage;

    let capturedSend: CapturedSend | null = null;
    let resolveSend: (() => void) | null = null;
    let resolveRemoved: (() => void) | null = null;
    const sendObserved = new Promise<void>((resolve) => {
      resolveSend = resolve;
    });
    const removeObserved = new Promise<void>((resolve) => {
      resolveRemoved = resolve;
    });

    chatManager.sendMessage = (async (chatId: string, text: string, options) => {
      capturedSend = {
        chatId,
        text,
        imagePaths: options?.imagePaths,
        onActivity: options?.onActivity,
      };
      resolveSend?.();
      return undefined;
    }) as typeof chatManager.sendMessage;

    await handleMessage(createPostEvent(
      'msg-post-1',
      'oc_post_chat',
      'p2p_chat',
      {
        zh_cn: {
          title: '图文消息',
          content: [
            [
              { tag: 'text', text: '请看这张图，并结合图片继续分析。' },
            ],
            [
              { tag: 'img', image_key: 'img_key_1' },
            ],
          ],
        },
      },
    ) as never);

    await waitWithTimeout(sendObserved, 'sendObserved');
    await new Promise(resolve => setTimeout(resolve, 0));
    await waitWithTimeout(removeObserved, 'removeObserved');

    assert.deepEqual(downloadCalls, [
      {
        messageId: 'msg-post-1',
        imageKey: 'img_key_1',
      },
    ]);
    assert.deepEqual(textMessages, []);
    assert.deepEqual(removedReactions, ['reaction-1']);
    assert.ok(capturedSend);
    const send = capturedSend as CapturedSend;
    assert.equal(send.chatId, 'oc_post_chat');
    assert.equal(send.text, '请看这张图，并结合图片继续分析。');
    assert.deepEqual(send.imagePaths, ['C:\\tmp\\img_key_1.png']);
    assert.equal(typeof send.onActivity, 'function');

    console.log('post-message-handler.test.ts passed');
  } finally {
    messageService.downloadMessageImage = originalDownloadMessageImage;
    messageService.addReaction = originalAddReaction;
    messageService.removeReaction = originalRemoveReaction;
    messageService.sendTextMessage = originalSendTextMessage;
    chatManager.sendMessage = originalSendMessage;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

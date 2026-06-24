import assert from 'assert/strict';

process.env.FEISHU_APP_ID = process.env.FEISHU_APP_ID || 'test-app-id';
process.env.FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET || 'test-app-secret';
process.env.FEISHU_ALLOWED_OPEN_IDS = 'ou_admin';

const { handleMessage } = require('../src/handlers/message.handler') as typeof import('../src/handlers/message.handler');
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

function createTextEvent(messageId: string, openId: string, text: string): MessageEvent {
  return {
    sender: {
      sender_id: {
        open_id: openId,
      },
      sender_type: 'user',
    },
    message: {
      message_id: messageId,
      message_type: 'text',
      content: JSON.stringify({ text }),
      chat_id: 'oc_whoami',
      chat_type: 'group_chat',
    },
  };
}

async function main(): Promise<void> {
  const originalSendTextMessage = messageService.sendTextMessage.bind(messageService);

  try {
    let observedText = '';
    messageService.sendTextMessage = (async (_chatId: string, text: string) => {
      observedText = text;
    }) as typeof messageService.sendTextMessage;

    await handleMessage(createTextEvent('om_whoami_guest', 'ou_guest', '/whoami') as never);

    assert.match(observedText, /open_id: ou_guest/);
    assert.match(observedText, /chat_id: oc_whoami/);
    assert.doesNotMatch(observedText, /FEISHU_ALLOWED_OPEN_IDS/);

    console.log('whoami-handler.test.ts passed');
  } finally {
    messageService.sendTextMessage = originalSendTextMessage as typeof messageService.sendTextMessage;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

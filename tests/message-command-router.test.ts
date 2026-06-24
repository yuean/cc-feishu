import assert from 'assert/strict';

process.env.FEISHU_APP_ID = process.env.FEISHU_APP_ID || 'test-app-id';
process.env.FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET || 'test-app-secret';
process.env.FEISHU_ALLOWED_OPEN_IDS = 'ou_admin,ou_ops';

const {
  handleMessageCommand,
} = require('../src/bot/message-command-router') as typeof import('../src/bot/message-command-router');
const { chatManager } = require('../src/bot/chat-manager') as typeof import('../src/bot/chat-manager');
const messageService = (require('../src/services/message.service') as typeof import('../src/services/message.service')).default;

function createTask(text: string, chatId = 'oc_command_router') {
  return {
    text,
    messageType: 'text',
    message: {
      message_id: `om_${text.replace(/\W+/g, '_') || 'plain'}`,
      chat_id: chatId,
    },
  };
}

async function main(): Promise<void> {
  const originalSendTextMessage = messageService.sendTextMessage.bind(messageService);
  const originalSendCardMessage = messageService.sendCardMessage.bind(messageService);
  const originalAddReaction = messageService.addReaction.bind(messageService);
  const originalRemoveReaction = messageService.removeReaction.bind(messageService);
  const originalGetDetailedSessionInfo = chatManager.getDetailedSessionInfo.bind(chatManager);
  const originalSendMessage = chatManager.sendMessage.bind(chatManager);

  try {
    const textMessages: string[] = [];
    const cardMessages: string[] = [];
    const sentPrompts: string[] = [];
    const removedReactions: string[] = [];

    messageService.sendTextMessage = (async (_chatId: string, text: string) => {
      textMessages.push(text);
    }) as typeof messageService.sendTextMessage;
    messageService.sendCardMessage = (async (_chatId: string, markdown: string) => {
      cardMessages.push(markdown);
    }) as typeof messageService.sendCardMessage;
    messageService.addReaction = (async () => 'reaction-id') as typeof messageService.addReaction;
    messageService.removeReaction = (async (_messageId: string, reactionId: string) => {
      removedReactions.push(reactionId);
    }) as typeof messageService.removeReaction;
    chatManager.getDetailedSessionInfo = (() => '当前没有活跃会话\nProvider: codex\n工作目录: C:\\work') as typeof chatManager.getDetailedSessionInfo;
    chatManager.sendMessage = (async (_chatId: string, text: string) => {
      sentPrompts.push(text);
    }) as typeof chatManager.sendMessage;

    const statResult = await handleMessageCommand(createTask('/stat'), {
      getActiveTaskStatus: () => '\n当前任务:\n- 状态: 运行中',
    });
    assert.equal(statResult.kind, 'command');
    assert.equal(
      textMessages.at(-1),
      '当前没有活跃会话\nProvider: codex\n工作目录: C:\\work\n当前任务:\n- 状态: 运行中',
    );

    const agentResult = await handleMessageCommand(createTask('/agent'), {
      getActiveTaskStatus: () => null,
    });
    assert.equal(agentResult.kind, 'command');
    assert.match(cardMessages.at(-1) ?? '', /选择 Agent/);

    const unknownResult = await handleMessageCommand(createTask('/wat'), {
      getActiveTaskStatus: () => null,
    });
    assert.equal(unknownResult.kind, 'command');
    assert.equal(textMessages.at(-1), '未知命令: /wat\n输入 /help 查看可用命令。');

    const plainResult = await handleMessageCommand(createTask('继续实现'), {
      getActiveTaskStatus: () => null,
    });
    assert.equal(plainResult.kind, 'agent_message');
    assert.deepEqual(sentPrompts, ['继续实现']);
    assert.deepEqual(removedReactions, ['reaction-id']);

    console.log('message-command-router.test.ts passed');
  } finally {
    messageService.sendTextMessage = originalSendTextMessage as typeof messageService.sendTextMessage;
    messageService.sendCardMessage = originalSendCardMessage as typeof messageService.sendCardMessage;
    messageService.addReaction = originalAddReaction as typeof messageService.addReaction;
    messageService.removeReaction = originalRemoveReaction as typeof messageService.removeReaction;
    chatManager.getDetailedSessionInfo = originalGetDetailedSessionInfo as typeof chatManager.getDetailedSessionInfo;
    chatManager.sendMessage = originalSendMessage as typeof chatManager.sendMessage;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

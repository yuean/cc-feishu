import assert from 'assert/strict';

process.env.FEISHU_APP_ID = process.env.FEISHU_APP_ID || 'test-app-id';
process.env.FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET || 'test-app-secret';

const messageServiceModule = require('../src/services/message.service') as typeof import('../src/services/message.service');
const messageService = messageServiceModule.default;
const { ChatManager } = require('../src/bot/chat-manager') as typeof import('../src/bot/chat-manager');
const {
  appendFeishuAttachmentInstructions,
} = require('../src/bot/response-attachments') as typeof import('../src/bot/response-attachments');

type ResponseCallback = (text: string) => void;

async function main(): Promise<void> {
  const cardMessages: string[] = [];
  const textMessages: string[] = [];
  const imageMessages: string[] = [];
  const fileMessages: string[] = [];

  const originalSendCardMessage = messageService.sendCardMessage;
  const originalSendTextMessage = messageService.sendTextMessage;
  const originalSendImageMessage = messageService.sendImageMessage;
  const originalSendFileMessage = messageService.sendFileMessage;

  try {
    messageService.sendCardMessage = async (_chatId: string, markdown: string): Promise<void> => {
      cardMessages.push(markdown);
    };
    messageService.sendTextMessage = async (_chatId: string, text: string): Promise<void> => {
      textMessages.push(text);
    };
    messageService.sendImageMessage = async (_chatId: string, imagePath: string): Promise<void> => {
      imageMessages.push(imagePath);
    };
    messageService.sendFileMessage = async (_chatId: string, filePath: string): Promise<void> => {
      fileMessages.push(filePath);
    };

    let responseCallback: ResponseCallback | null = null;
    const prompts: string[] = [];

    const fakeAgent = {
      async sendMessage(text: string): Promise<void> {
        prompts.push(text);
        if (prompts.length === 1) {
          responseCallback?.([
            '文档已生成。',
            '[[feishu_file:reports\\\\summary.docx]]',
          ].join('\n'));
          return;
        }

        responseCallback?.([
          '处理完成。',
          '[[feishu_image:output\\\\poster.png]]',
        ].join('\n'));
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
        return 'session-alpha';
      },
      isInitialized(): boolean {
        return true;
      },
      isAlive(): boolean {
        return true;
      },
      onResponse(callback: ResponseCallback): void {
        responseCallback = callback;
      },
      onError(): void {},
      getStartTime(): number {
        return Date.now();
      },
      getRuntimeStatus() {
        return {
          phase: 'idle' as const,
          detail: '本轮已完成',
          updatedAt: Date.now(),
          lastActivityAt: Date.now(),
          activityCount: 1,
          isTurnInProgress: false,
        };
      },
    };

    const manager = new ChatManager({
      defaultCwd: 'C:\\work',
      defaultProvider: 'codex',
      agentFactory: () => fakeAgent,
    });

    const docRequest = '请生成一份总结文档并发回飞书。';
    await manager.sendMessage('oc_chat', docRequest);
    await flushAsyncWork();

    assert.equal(prompts[0], appendFeishuAttachmentInstructions(docRequest));
    assert.match(prompts[0], /Do not mark source code files, scripts/);
    assert.deepEqual(textMessages, [
      '已新开会话。',
      '新会话已创建: C:\\work (session-alpha)',
    ]);
    textMessages.length = 0;
    assert.deepEqual(cardMessages, ['文档已生成。']);
    assert.deepEqual(imageMessages, []);
    assert.deepEqual(fileMessages, ['C:\\work\\reports\\summary.docx']);

    cardMessages.length = 0;
    imageMessages.length = 0;
    fileMessages.length = 0;

    const attachmentRequest = appendFeishuAttachmentInstructions('请生成海报并回传。');

    await manager.sendMessage('oc_chat', attachmentRequest);
    await flushAsyncWork();

    assert.equal(prompts[1], attachmentRequest);
    assert.deepEqual(textMessages, []);
    assert.deepEqual(cardMessages, ['处理完成。']);
    assert.deepEqual(imageMessages, ['C:\\work\\output\\poster.png']);
    assert.deepEqual(fileMessages, []);

    console.log('chat-manager-feishu-attachments.test.ts passed');
  } finally {
    messageService.sendCardMessage = originalSendCardMessage;
    messageService.sendTextMessage = originalSendTextMessage;
    messageService.sendImageMessage = originalSendImageMessage;
    messageService.sendFileMessage = originalSendFileMessage;
  }
}

function flushAsyncWork(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

import { chatManager } from '../bot/chat-manager';
import messageService from '../services/message.service';
import logger from '../utils/logger';
import type { MessageEvent, ParsedMessageTask } from './message-intake';

type MediaTaskType = 'image' | 'file' | 'post';

export interface QueuedMessageTask {
  data: MessageEvent;
  text: string;
  messageType: string;
  imagePaths?: string[];
  enqueuedAt: number;
}

export async function materializeQueuedTask(task: ParsedMessageTask): Promise<QueuedMessageTask | null> {
  if (task.messageType === 'text') {
    return createQueuedTask(task, task.text);
  }

  if (task.messageType === 'image') {
    return materializeImageTask(task);
  }

  if (task.messageType === 'file') {
    return materializeFileTask(task);
  }

  if (task.messageType === 'post') {
    return materializePostTask(task);
  }

  return null;
}

async function materializeImageTask(task: ParsedMessageTask): Promise<QueuedMessageTask | null> {
  const { message } = task.data;
  const chatId = message.chat_id;
  const imageKey = task.imageKey;

  if (!(await ensureMediaProviderSupport(chatId, 'image'))) {
    return null;
  }

  if (!imageKey) {
    logger.warn('Skipping image message without image key', {
      messageId: message.message_id,
      chatId,
    });
    return null;
  }

  try {
    const imagePath = await messageService.downloadMessageImage(message.message_id, imageKey);
    return createQueuedTask(task, task.text, [imagePath]);
  } catch (error) {
    logger.error('Failed to download image message resource', {
      messageId: message.message_id,
      chatId,
      imageKey,
      error,
    });
    await messageService.sendTextMessage(chatId, '图片下载失败，请稍后重试。');
    return null;
  }
}

async function materializeFileTask(task: ParsedMessageTask): Promise<QueuedMessageTask | null> {
  const { message } = task.data;
  const chatId = message.chat_id;
  const fileKey = task.fileKey;
  const fileName = task.fileName;

  if (!(await ensureMediaProviderSupport(chatId, 'file'))) {
    return null;
  }

  if (!fileKey) {
    logger.warn('Skipping file message without file key', {
      messageId: message.message_id,
      chatId,
    });
    return null;
  }

  try {
    const filePath = await messageService.downloadMessageFile(message.message_id, fileKey, fileName);
    return createQueuedTask(task, buildFilePrompt(filePath, fileName));
  } catch (error) {
    logger.error('Failed to download file message resource', {
      messageId: message.message_id,
      chatId,
      fileKey,
      fileName,
      error,
    });
    await messageService.sendTextMessage(chatId, '文件下载失败，请稍后重试。');
    return null;
  }
}

async function materializePostTask(task: ParsedMessageTask): Promise<QueuedMessageTask | null> {
  const { message } = task.data;
  const chatId = message.chat_id;
  const imageKeys = task.imageKeys ?? [];

  if (imageKeys.length > 0 && !(await ensureMediaProviderSupport(chatId, 'post'))) {
    return null;
  }

  const imagePaths: string[] = [];
  for (const imageKey of imageKeys) {
    try {
      imagePaths.push(await messageService.downloadMessageImage(message.message_id, imageKey));
    } catch (error) {
      logger.error('Failed to download post image resource', {
        messageId: message.message_id,
        chatId,
        imageKey,
        error,
      });
      await messageService.sendTextMessage(chatId, '图片下载失败，请稍后重试。');
      return null;
    }
  }

  return createQueuedTask(task, task.text, imagePaths.length > 0 ? imagePaths : undefined);
}

function createQueuedTask(task: ParsedMessageTask, text: string, imagePaths?: string[]): QueuedMessageTask {
  return {
    data: task.data,
    text,
    messageType: task.messageType,
    imagePaths,
    enqueuedAt: Date.now(),
  };
}

async function ensureMediaProviderSupport(chatId: string, messageType: MediaTaskType): Promise<boolean> {
  if (chatManager.getProvider(chatId) === 'codex') {
    return true;
  }

  await messageService.sendTextMessage(chatId, getUnsupportedMediaText(messageType));
  return false;
}

function getUnsupportedMediaText(messageType: MediaTaskType): string {
  if (messageType === 'post') {
    return '当前仅 Codex 支持图文消息中的图片内容，请先使用 /agent 切换到 Codex。';
  }

  return `当前仅 Codex 支持${messageType === 'image' ? '图片' : '文件'}消息，请先使用 /agent 切换到 Codex。`;
}

function buildFilePrompt(filePath: string, fileName?: string): string {
  return [
    `用户发送了一个文件${fileName ? `：${fileName}` : ''}。`,
    `文件已保存到本地路径：${filePath}`,
    '请先读取该文件，再继续处理当前请求。',
  ].join('\n');
}

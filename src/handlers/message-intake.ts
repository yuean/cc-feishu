import logger from '../utils/logger';

export interface MessageEvent {
  sender: {
    sender_id: {
      open_id: string;
      user_id?: string;
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

interface TextMessageContent {
  text?: string;
}

interface ImageMessageContent {
  image_key?: string;
}

interface FileMessageContent {
  file_key?: string;
  file_name?: string;
}

interface PostMessageBlock {
  tag?: string;
  text?: string;
  content?: string;
  image_key?: string;
  imageKey?: string;
  href?: string;
  user_name?: string;
  user_id?: string;
}

interface PostMessageLocaleContent {
  title?: string;
  content?: PostMessageBlock[][];
}

interface ParsedPostMessageContent {
  text: string;
  imageKeys: string[];
}

export interface ParsedMessageTask {
  data: MessageEvent;
  text: string;
  messageType: string;
  imageKey?: string;
  imageKeys?: string[];
  fileKey?: string;
  fileName?: string;
}

export function parseMessageTask(data: MessageEvent): ParsedMessageTask | null {
  const { message } = data;

  if (message.message_type === 'text') {
    return parseTextTask(data);
  }

  if (message.message_type === 'image') {
    return parseImageTask(data);
  }

  if (message.message_type === 'file') {
    return parseFileTask(data);
  }

  if (message.message_type === 'post') {
    return parsePostTask(data);
  }

  logger.debug('Skipping unsupported message type', {
    messageId: message.message_id,
    chatId: message.chat_id,
    messageType: message.message_type,
  });
  return null;
}

function parseTextTask(data: MessageEvent): ParsedMessageTask | null {
  const { message } = data;

  let content: TextMessageContent;
  try {
    content = JSON.parse(message.content) as TextMessageContent;
  } catch (error) {
    logger.error('Failed to parse text message content', {
      messageId: message.message_id,
      chatId: message.chat_id,
      error,
    });
    return null;
  }

  const text = (content.text || '').trim();
  if (!text) {
    logger.debug('Skipping empty text message', {
      messageId: message.message_id,
      chatId: message.chat_id,
    });
    return null;
  }

  return {
    data,
    text,
    messageType: 'text',
  };
}

function parseImageTask(data: MessageEvent): ParsedMessageTask | null {
  const { message } = data;
  const chatId = message.chat_id;

  let content: ImageMessageContent;
  try {
    content = JSON.parse(message.content) as ImageMessageContent;
  } catch (error) {
    logger.error('Failed to parse image message content', {
      messageId: message.message_id,
      chatId,
      error,
    });
    return null;
  }

  const imageKey = content.image_key?.trim();
  if (!imageKey) {
    logger.warn('Skipping image message without image key', {
      messageId: message.message_id,
      chatId,
    });
    return null;
  }

  return {
    data,
    text: '用户发送了一张图片，请结合图片内容继续处理当前请求。',
    messageType: 'image',
    imageKey,
  };
}

function parseFileTask(data: MessageEvent): ParsedMessageTask | null {
  const { message } = data;
  const chatId = message.chat_id;

  let content: FileMessageContent;
  try {
    content = JSON.parse(message.content) as FileMessageContent;
  } catch (error) {
    logger.error('Failed to parse file message content', {
      messageId: message.message_id,
      chatId,
      error,
    });
    return null;
  }

  const fileKey = content.file_key?.trim();
  if (!fileKey) {
    logger.warn('Skipping file message without file key', {
      messageId: message.message_id,
      chatId,
    });
    return null;
  }

  return {
    data,
    text: '用户发送了一个文件。',
    messageType: 'file',
    fileKey,
    fileName: content.file_name,
  };
}

function parsePostTask(data: MessageEvent): ParsedMessageTask | null {
  const { message } = data;
  const chatId = message.chat_id;
  const parsed = parsePostMessageContent(message.content);

  if (!parsed) {
    logger.debug('Skipping post message without usable content', {
      messageId: message.message_id,
      chatId,
    });
    return null;
  }

  const imageKeys = parsed.imageKeys.filter(Boolean);
  const text = parsed.text || (
    imageKeys.length > 0
      ? '用户发送了一条图文消息，请结合图片内容继续处理当前请求。'
      : ''
  );

  if (!text) {
    logger.debug('Skipping empty post message', {
      messageId: message.message_id,
      chatId,
    });
    return null;
  }

  return {
    data,
    text,
    messageType: 'post',
    imageKeys,
  };
}

function parsePostMessageContent(content: string): ParsedPostMessageContent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    logger.error('Failed to parse post message content', { error });
    return null;
  }

  const localeContent = resolvePostLocaleContent(parsed);
  if (!localeContent) {
    return null;
  }

  const rows = localeContent.content ?? [];
  const textLines: string[] = [];
  const imageKeys = new Set<string>();

  for (const row of rows) {
    if (!Array.isArray(row)) {
      continue;
    }

    const fragments: string[] = [];
    for (const block of row) {
      if (!isRecord(block)) {
        continue;
      }

      const typedBlock = block as PostMessageBlock;
      const imageKey = extractPostImageKey(typedBlock);
      if (imageKey) {
        imageKeys.add(imageKey);
        continue;
      }

      const text = extractPostBlockText(typedBlock);
      if (text) {
        fragments.push(text);
      }
    }

    const line = trimBlankEdges(fragments.join(''));
    if (line) {
      textLines.push(line);
    }
  }

  return {
    text: trimBlankEdges(textLines.join('\n')),
    imageKeys: Array.from(imageKeys),
  };
}

function resolvePostLocaleContent(rawContent: unknown): PostMessageLocaleContent | null {
  if (isPostLocaleContent(rawContent)) {
    return rawContent;
  }

  if (!isRecord(rawContent)) {
    return null;
  }

  const preferredLocales = ['zh_cn', 'zh_tw', 'en_us', 'ja_jp', 'ko_kr'];
  for (const locale of preferredLocales) {
    const candidate = rawContent[locale];
    if (isPostLocaleContent(candidate)) {
      return candidate;
    }
  }

  for (const value of Object.values(rawContent)) {
    if (isPostLocaleContent(value)) {
      return value;
    }
  }

  return null;
}

function isPostLocaleContent(value: unknown): value is PostMessageLocaleContent {
  return isRecord(value) && Array.isArray(value.content);
}

function extractPostBlockText(block: PostMessageBlock): string {
  const primaryText = readStringValue(block.text) ?? readStringValue(block.content);
  if (primaryText) {
    return primaryText.trim();
  }

  if ((block.tag ?? '').toLowerCase() === 'at') {
    const userName = readStringValue(block.user_name);
    if (userName) {
      return `@${userName.trim()}`;
    }
  }

  if ((block.tag ?? '').toLowerCase() === 'a') {
    const href = readStringValue(block.href);
    if (href) {
      return href.trim();
    }
  }

  return '';
}

function extractPostImageKey(block: PostMessageBlock): string | undefined {
  const imageKey = readStringValue(block.image_key) ?? readStringValue(block.imageKey);
  return imageKey?.trim() || undefined;
}

function readStringValue(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return `${value}`;
  }

  return undefined;
}

function trimBlankEdges(text: string): string {
  return text.replace(/^\s*\n+|\n+\s*$/g, '').trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

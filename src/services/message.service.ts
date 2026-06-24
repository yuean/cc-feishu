import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import feishuClient from '../bot/client';
import logger from '../utils/logger';

const FEISHU_MEDIA_DIR = path.resolve(process.cwd(), 'tmp', 'feishu-media');
const INLINE_CODE_WRAPPED_URL_RE = /(^|[^`])`(https?:\/\/[^\s`]+)`(?=($|[^\w/=&?#%.-]))/g;
const MAX_FEISHU_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_FEISHU_FILE_BYTES = 30 * 1024 * 1024;
const SUPPORTED_FEISHU_IMAGE_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.gif',
  '.tif',
  '.tiff',
  '.bmp',
  '.ico',
]);

type FeishuFileType = 'opus' | 'mp4' | 'pdf' | 'doc' | 'xls' | 'ppt' | 'stream';

class MessageService {
  async addReaction(messageId: string, emojiType: string): Promise<string | null> {
    try {
      const client = feishuClient.getClient();
      const res = await (client.im.messageReaction as any).create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: emojiType } },
      });
      return res?.data?.reaction_id ?? null;
    } catch (error) {
      logger.warn('Failed to add reaction', { messageId, emojiType, error });
      return null;
    }
  }

  async removeReaction(messageId: string, reactionId: string): Promise<void> {
    try {
      const client = feishuClient.getClient();
      await (client.im.messageReaction as any).delete({
        path: { message_id: messageId, reaction_id: reactionId },
      });
    } catch (error) {
      logger.warn('Failed to remove reaction', { messageId, reactionId, error });
    }
  }

  async sendTextMessage(chatId: string, text: string): Promise<void> {
    try {
      const client = feishuClient.getClient();

      await client.im.message.create({
        params: {
          receive_id_type: 'chat_id',
        },
        data: {
          receive_id: chatId,
          msg_type: 'text',
          content: JSON.stringify({ text }),
        },
      });

      logger.info('Text message sent', { chatId, text });
    } catch (error) {
      logger.error('Failed to send text message', { error, chatId });
      throw error;
    }
  }

  async sendCardMessage(chatId: string, markdown: string): Promise<void> {
    try {
      const client = feishuClient.getClient();
      const normalizedMarkdown = normalizeFeishuMarkdown(markdown);

      await client.im.message.create({
        params: {
          receive_id_type: 'chat_id',
        },
        data: {
          receive_id: chatId,
          msg_type: 'interactive',
          content: JSON.stringify({
            config: {
              wide_screen_mode: true,
            },
            elements: [
              {
                tag: 'markdown',
                content: normalizedMarkdown,
              },
            ],
          }),
        },
      });

      logger.info('Card message sent', {
        chatId,
        contentLength: normalizedMarkdown.length,
        markdown: normalizedMarkdown,
      });
    } catch (error) {
      logger.error('Failed to send card message', { error, chatId });
      throw error;
    }
  }

  async sendImageMessage(chatId: string, imagePath: string): Promise<void> {
    try {
      await assertLocalFile(imagePath, MAX_FEISHU_IMAGE_BYTES);

      const extension = path.extname(imagePath).toLowerCase();
      if (!SUPPORTED_FEISHU_IMAGE_EXTENSIONS.has(extension)) {
        throw new Error(`Unsupported image format: ${extension || '(none)'}`);
      }

      const client = feishuClient.getClient();
      const uploadResponse = await client.im.image.create({
        data: {
          image_type: 'message',
          image: createReadStream(imagePath),
        },
      });

      const imageKey = uploadResponse?.image_key?.trim();
      if (!imageKey) {
        throw new Error('Feishu image upload did not return image_key');
      }

      await client.im.message.create({
        params: {
          receive_id_type: 'chat_id',
        },
        data: {
          receive_id: chatId,
          msg_type: 'image',
          content: JSON.stringify({ image_key: imageKey }),
        },
      });

      logger.info('Image message sent', {
        chatId,
        imagePath,
        imageKey,
      });
    } catch (error) {
      const readableError = toReadableError(error);
      logger.error('Failed to send image message', {
        error,
        readableError: readableError.message,
        chatId,
        imagePath,
      });
      throw readableError;
    }
  }

  async sendFileMessage(chatId: string, filePath: string): Promise<void> {
    try {
      await assertLocalFile(filePath, MAX_FEISHU_FILE_BYTES);

      const client = feishuClient.getClient();
      const fileName = path.basename(filePath);
      const uploadResponse = await client.im.file.create({
        data: {
          file_type: resolveFeishuFileType(filePath),
          file_name: fileName,
          file: createReadStream(filePath),
        },
      });

      const fileKey = uploadResponse?.file_key?.trim();
      if (!fileKey) {
        throw new Error('Feishu file upload did not return file_key');
      }

      await client.im.message.create({
        params: {
          receive_id_type: 'chat_id',
        },
        data: {
          receive_id: chatId,
          msg_type: 'file',
          content: JSON.stringify({ file_key: fileKey }),
        },
      });

      logger.info('File message sent', {
        chatId,
        filePath,
        fileKey,
      });
    } catch (error) {
      const readableError = toReadableError(error);
      logger.error('Failed to send file message', {
        error,
        readableError: readableError.message,
        chatId,
        filePath,
      });
      throw readableError;
    }
  }

  async downloadMessageImage(messageId: string, imageKey: string): Promise<string> {
    const resource = await this.downloadMessageResource(messageId, imageKey, 'image');
    const extension = resolveImageExtension(resource?.headers);
    const filePath = path.join(FEISHU_MEDIA_DIR, `${messageId}-${Date.now()}${extension}`);
    await resource.writeFile(filePath);

    logger.info('Downloaded image message resource', {
      messageId,
      imageKey,
      filePath,
    });

    return filePath;
  }

  async downloadMessageFile(messageId: string, fileKey: string, fileName?: string): Promise<string> {
    const resource = await this.downloadMessageResource(messageId, fileKey, 'file');
    const fallbackExtension = resolveFileExtension(resource?.headers);
    const safeFileName = buildStoredFileName(messageId, fileName, fallbackExtension);
    const filePath = path.join(FEISHU_MEDIA_DIR, safeFileName);
    await resource.writeFile(filePath);

    logger.info('Downloaded file message resource', {
      messageId,
      fileKey,
      fileName,
      filePath,
    });

    return filePath;
  }

  private async downloadMessageResource(messageId: string, fileKey: string, type: 'image' | 'file'): Promise<any> {
    const client = feishuClient.getClient();
    await mkdir(FEISHU_MEDIA_DIR, { recursive: true });

    return (client.im.messageResource as any).get({
      path: {
        message_id: messageId,
        file_key: fileKey,
      },
      params: {
        type,
      },
    });
  }
}

async function assertLocalFile(filePath: string, maxBytes: number): Promise<void> {
  const info = await stat(filePath);
  if (!info.isFile()) {
    throw new Error(`Path is not a file: ${filePath}`);
  }

  if (info.size <= 0) {
    throw new Error(`File is empty: ${filePath}`);
  }

  if (info.size > maxBytes) {
    throw new Error(`File exceeds Feishu upload limit (${maxBytes} bytes): ${filePath}`);
  }
}

interface ErrorDetail {
  message: string;
  priority: number;
}

export function describeFeishuApiError(error: unknown): string {
  const details: ErrorDetail[] = [];
  collectErrorDetails(error, new Set<unknown>(), details);

  if (details.length === 0) {
    return fallbackErrorMessage(error);
  }

  details.sort((left, right) => right.priority - left.priority);
  return details[0].message;
}

function toReadableError(error: unknown): Error {
  const message = describeFeishuApiError(error);
  if (error instanceof Error && error.message.trim() === message) {
    return error;
  }

  return new Error(message, { cause: error });
}

function collectErrorDetails(value: unknown, visited: Set<unknown>, details: ErrorDetail[]): void {
  if (value == null) {
    return;
  }

  if (typeof value === 'string') {
    addErrorDetail(details, buildDetailedMessage(value), classifyErrorPriority(value));
    return;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    addErrorDetail(details, `${value}`, 0);
    return;
  }

  if (typeof value !== 'object') {
    return;
  }

  if (visited.has(value)) {
    return;
  }
  visited.add(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      collectErrorDetails(item, visited, details);
    }
    return;
  }

  if (value instanceof Error) {
    if (value.message.trim()) {
      addErrorDetail(details, buildDetailedMessage(value.message), classifyErrorPriority(value.message));
    }

    const cause = (value as Error & { cause?: unknown }).cause;
    if (cause !== undefined) {
      collectErrorDetails(cause, visited, details);
    }
  }

  if (!isRecord(value)) {
    return;
  }

  const code = readScalar(value.code);
  const rawMessage = readScalar(value.msg) ?? readScalar(value.message);
  if (rawMessage) {
    addErrorDetail(
      details,
      buildDetailedMessage(rawMessage, code),
      classifyErrorPriority(rawMessage, code),
    );
  }

  if ('response' in value) {
    collectErrorDetails(value.response, visited, details);
  }

  if ('data' in value) {
    collectErrorDetails(value.data, visited, details);
  }

  if ('error' in value) {
    collectErrorDetails(value.error, visited, details);
  }

  if ('permission_violations' in value) {
    collectErrorDetails(value.permission_violations, visited, details);
  }
}

function addErrorDetail(details: ErrorDetail[], message: string, priority: number): void {
  if (!message) {
    return;
  }

  if (details.some(detail => detail.message === message)) {
    return;
  }

  details.push({ message, priority });
}

function buildDetailedMessage(message: string, code?: string): string {
  const normalized = normalizeMessage(message);
  const scopeMatch = normalized.match(/Access denied\. One of the following scopes is required:\s*(\[[^\]]+\])/i);
  if (scopeMatch) {
    return `Feishu access denied: missing scopes ${scopeMatch[1]}${code ? ` (code: ${code})` : ''}`;
  }

  const cleaned = normalized.replace(/\s*https?:\/\/\S+/gi, '').trim();
  if (!cleaned) {
    return code ? `Feishu API error (code: ${code})` : normalized;
  }

  return code ? `${cleaned} (code: ${code})` : cleaned;
}

function classifyErrorPriority(message: string, code?: string): number {
  const normalized = normalizeMessage(message);
  if (code) {
    return 100;
  }

  if (/Access denied|required:\s*\[[^\]]+\]/i.test(normalized)) {
    return 90;
  }

  if (/did not return (image_key|file_key)|Unsupported image format|File exceeds Feishu upload limit|Path is not a file|File is empty/i.test(normalized)) {
    return 80;
  }

  if (/Request failed with status code/i.test(normalized)) {
    return 10;
  }

  return 50;
}

function normalizeMessage(message: string): string {
  return message.replace(/\s+/g, ' ').trim();
}

function readScalar(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return `${value}`;
  }

  return undefined;
}

function fallbackErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }

  return `${error}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function normalizeFeishuMarkdown(markdown: string): string {
  return markdown.replace(INLINE_CODE_WRAPPED_URL_RE, (_match, prefix: string, url: string) => {
    return `${prefix}[${url}](${url})`;
  });
}

function resolveImageExtension(headers: unknown): string {
  const contentType = readHeader(headers, 'content-type');
  switch (contentType) {
    case 'image/jpeg':
      return '.jpg';
    case 'image/png':
      return '.png';
    case 'image/webp':
      return '.webp';
    case 'image/gif':
      return '.gif';
    case 'image/bmp':
      return '.bmp';
    case 'image/tiff':
      return '.tiff';
    case 'image/x-icon':
      return '.ico';
    default:
      return '.img';
  }
}

function readHeader(headers: unknown, targetName: string): string {
  if (!headers || typeof headers !== 'object') {
    return '';
  }

  const normalizedTargetName = targetName.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== normalizedTargetName) {
      continue;
    }

    if (Array.isArray(value)) {
      return `${value[0] ?? ''}`.toLowerCase();
    }

    return `${value ?? ''}`.toLowerCase();
  }

  return '';
}

function resolveFileExtension(headers: unknown): string {
  const contentDisposition = readHeader(headers, 'content-disposition');
  const match = contentDisposition.match(/filename\*?=(?:UTF-8''|\"?)([^\";]+)/i);
  if (match?.[1]) {
    const candidate = decodeURIComponent(match[1].replace(/^\"|\"$/g, ''));
    return path.extname(candidate) || '.bin';
  }

  return '.bin';
}

function buildStoredFileName(messageId: string, fileName: string | undefined, fallbackExtension: string): string {
  const timestamp = Date.now();
  const sanitizedBaseName = sanitizeBaseName(fileName);
  const extension = path.extname(fileName ?? '') || fallbackExtension;
  return `${messageId}-${timestamp}-${sanitizedBaseName}${extension}`;
}

function sanitizeBaseName(fileName?: string): string {
  const baseName = path.basename(fileName ?? '', path.extname(fileName ?? '')).trim();
  const sanitized = baseName.replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_').replace(/\s+/g, '_');
  return sanitized || 'file';
}

function resolveFeishuFileType(filePath: string): FeishuFileType {
  switch (path.extname(filePath).toLowerCase()) {
    case '.opus':
      return 'opus';
    case '.mp4':
      return 'mp4';
    case '.pdf':
      return 'pdf';
    case '.doc':
    case '.docx':
      return 'doc';
    case '.xls':
    case '.xlsx':
    case '.csv':
    case '.tsv':
      return 'xls';
    case '.ppt':
    case '.pptx':
      return 'ppt';
    default:
      return 'stream';
  }
}

export default new MessageService();

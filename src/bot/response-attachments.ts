import path from 'node:path';

export type FeishuAttachmentKind = 'image' | 'file';

export interface FeishuResponseAttachment {
  kind: FeishuAttachmentKind;
  originalPath: string;
  resolvedPath: string;
}

export interface ParsedFeishuResponse {
  text: string;
  attachments: FeishuResponseAttachment[];
}

const ATTACHMENT_MARKER = /^\s*\[\[(feishu_image|feishu_file):(.+?)\]\]\s*$/i;
const FEISHU_ATTACHMENT_PROTOCOL_HEADER = '[Feishu attachment upload protocol]';

const FEISHU_ATTACHMENT_PROTOCOL = [
  FEISHU_ATTACHMENT_PROTOCOL_HEADER,
  'If you create a local artifact that should be sent back to the user in Feishu, append one marker line per artifact at the end of your final response.',
  'Use [[feishu_image:relative-or-absolute-path]] for images.',
  'Use [[feishu_file:relative-or-absolute-path]] for files.',
  'Only mark final user-facing deliverables such as documents, spreadsheets, PDFs, images, slide decks, or archives that the user would want returned in Feishu.',
  'Do not mark source code files, scripts, patches, logs, temp files, or other intermediate artifacts unless the user explicitly asks for them.',
  'Only reference files that already exist on disk.',
  'Keep all normal explanation outside the marker lines.',
].join('\n');

export function appendFeishuAttachmentInstructions(text: string): string {
  if (hasFeishuAttachmentUploadProtocol(text)) {
    return text;
  }

  return `${text}\n\n${FEISHU_ATTACHMENT_PROTOCOL}`;
}

export function hasFeishuAttachmentUploadProtocol(text: string): boolean {
  return new RegExp(`^\\s*${escapeRegExp(FEISHU_ATTACHMENT_PROTOCOL_HEADER)}\\s*$`, 'im').test(text);
}

export function parseFeishuResponse(text: string, cwd: string): ParsedFeishuResponse {
  const attachments: FeishuResponseAttachment[] = [];
  const normalizedLines = text.replace(/\r\n/g, '\n').split('\n');
  const { contentLines, attachmentLines } = splitTrailingAttachmentLines(normalizedLines);

  for (const line of attachmentLines) {
    const match = line.match(ATTACHMENT_MARKER);
    if (!match) {
      continue;
    }

    const kind = match[1].toLowerCase() === 'feishu_image' ? 'image' : 'file';
    const originalPath = stripPathWrapper(match[2].trim());
    if (!originalPath) {
      continue;
    }

    attachments.push({
      kind,
      originalPath,
      resolvedPath: resolveAttachmentPath(cwd, originalPath),
    });
  }

  return {
    text: trimBlankEdges(contentLines.join('\n')),
    attachments,
  };
}

function splitTrailingAttachmentLines(lines: string[]): { contentLines: string[]; attachmentLines: string[] } {
  let markerBlockEnd = lines.length;
  while (markerBlockEnd > 0 && lines[markerBlockEnd - 1].trim() === '') {
    markerBlockEnd -= 1;
  }

  let markerBlockStart = markerBlockEnd;
  while (markerBlockStart > 0 && ATTACHMENT_MARKER.test(lines[markerBlockStart - 1])) {
    markerBlockStart -= 1;
  }

  if (markerBlockStart === markerBlockEnd) {
    return {
      contentLines: lines,
      attachmentLines: [],
    };
  }

  return {
    contentLines: lines.slice(0, markerBlockStart),
    attachmentLines: lines.slice(markerBlockStart, markerBlockEnd),
  };
}

function resolveAttachmentPath(cwd: string, filePath: string): string {
  return path.isAbsolute(filePath)
    ? path.normalize(filePath)
    : path.resolve(cwd, filePath);
}

function stripPathWrapper(filePath: string): string {
  if (filePath.length < 2) {
    return filePath;
  }

  const first = filePath[0];
  const last = filePath[filePath.length - 1];
  if ((first === '"' && last === '"') || (first === '\'' && last === '\'') || (first === '`' && last === '`')) {
    return filePath.slice(1, -1).trim();
  }

  return filePath;
}

function trimBlankEdges(text: string): string {
  return text
    .replace(/^\s*\n+/, '')
    .replace(/\n+\s*$/, '')
    .trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

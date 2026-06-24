import { existsSync, mkdirSync } from 'fs';

import type { SessionTarget } from '../agent/session-history';
import type { ActivityEvent } from '../agent/types';
import config, { type AgentProvider } from '../config';
import messageService from '../services/message.service';
import logger from '../utils/logger';
import { chatManager } from './chat-manager';
import { chatBindingStore } from './chat-binding-store';
import {
  isSingleSegmentRelativePath,
  isValidWindowsDirectoryName,
} from './directory-name';
import menuContext, { renderMenu, type MenuAction, type MenuContext } from './menu-context';
import {
  isDirectoryAvailable,
  resolveWorkPath,
  resolveWorkPathCandidate,
} from './work-directory';

export interface CommandRouteTask {
  text: string;
  messageType: string;
  imagePaths?: string[];
  message: {
    message_id: string;
    chat_id: string;
  };
}

export interface CommandRouteOptions {
  getActiveTaskStatus: (chatId: string) => string | null;
  onActivity?: (event?: ActivityEvent) => void;
}

export type CommandRouteResult =
  | { kind: 'command' }
  | { kind: 'agent_message' };

const MESSAGE_IDLE_TIMEOUT_MS = 300000;

function getHelpText(chatId: string): string {
  const lines = [
    '可用命令:',
    '/help - 显示帮助',
    '/new - 重置会话',
    '/stop - 打断当前任务',
    '/stat - 查看会话状态',
    '/agent - 选择 agent（支持数字选择）',
    '/cd - 列出最近的工作目录（支持数字选择）',
    '/cd <路径> - 绑定或修改当前群的工作目录，/cd . 绑定到根目录',
    '/debug - 查看调试信息',
  ];

  if (chatManager.supportsSessionResume(chatId)) {
    lines.push('/resume - 列出可恢复的 sessions（支持数字选择）');
    lines.push('/resume <编号|session_id> - 恢复指定 session');
  } else {
    lines.push('/resume - 当前 agent 暂不支持');
  }

  return lines.join('\n');
}

export function getInvalidBindingText(cwd: string): string {
  return `当前群绑定目录不存在: ${cwd}\n请重新使用 /cd <路径> 绑定。`;
}

export function formatDuration(seconds: number): string {
  const wholeSeconds = Math.max(0, Math.floor(seconds));
  if (wholeSeconds < 60) {
    return `${wholeSeconds}秒`;
  }
  if (wholeSeconds < 3600) {
    const minutes = Math.floor(wholeSeconds / 60);
    const secs = wholeSeconds % 60;
    return `${minutes}分${secs}秒`;
  }
  if (wholeSeconds < 86400) {
    const hours = Math.floor(wholeSeconds / 3600);
    const minutes = Math.floor((wholeSeconds % 3600) / 60);
    return `${hours}小时${minutes}分`;
  }
  const days = Math.floor(wholeSeconds / 86400);
  const hours = Math.floor((wholeSeconds % 86400) / 3600);
  return `${days}天${hours}小时`;
}

function formatSessionMenuLabel(session: { sessionId: string; mtimeMs: number; firstMessage?: string; cwd: string }, currentCwd: string): string {
  const shortId = session.sessionId.length > 8 ? `${session.sessionId.slice(0, 8)}...` : session.sessionId;
  const age = formatDuration((Date.now() - session.mtimeMs) / 1000);
  const summary = session.firstMessage || '无摘要';
  const cwdSuffix = session.cwd === currentCwd ? '' : ` · ${session.cwd}`;
  return `\`${shortId}\`  ${age}前${cwdSuffix}\n摘要 ${summary}`;
}

function formatDirectoryMenuLabel(directory: { cwd: string; mtimeMs: number }, currentCwd: string): string {
  const age = formatDuration((Date.now() - directory.mtimeMs) / 1000);
  const currentSuffix = directory.cwd === currentCwd ? '（当前）' : '';
  return `\`${directory.cwd}\`${currentSuffix}\n最近 session: ${age}前`;
}

function buildCwdMenu(chatId: string): MenuContext | null {
  const directories = chatManager.getRecentDirectories(chatId, 9);
  if (directories.length === 0) {
    return null;
  }

  const currentCwd = chatManager.getCurrentCwd(chatId);
  return {
    kind: 'cwd',
    title: `切换目录（最近 ${directories.length} 个）`,
    description: `当前工作目录: \`${currentCwd}\`\n按最近 session 去重排序。`,
    items: directories.map((directory, index) => ({
      index: index + 1,
      label: formatDirectoryMenuLabel(directory, currentCwd),
      action: { type: 'switch_cwd', cwd: directory.cwd },
    })),
    expiresAt: Date.now(),
  };
}

function buildCreateCwdMenu(input: string, target: string): Omit<MenuContext, 'expiresAt'> {
  return {
    kind: 'cwd',
    title: '创建工作目录？',
    description: `目录不存在: \`${input}\`\n目标路径: \`${target}\``,
    items: [
      {
        index: 1,
        label: '创建并切换到该目录',
        action: { type: 'create_cwd', cwd: target },
      },
    ],
  };
}

function buildResumeMenu(chatId: string): MenuContext | null {
  const sessions = chatManager.getRecentSessions(chatId, 9);
  if (sessions.length === 0) {
    return null;
  }

  const currentCwd = chatManager.getCurrentCwd(chatId);
  const total = chatManager.getSessionCount(chatId);
  const descriptionLines = [`工作目录: \`${currentCwd}\``];
  if (currentCwd === config.agent.workRoot) {
    descriptionLines.push('当前为默认目录，已显示所有目录最近会话。');
  }
  if (total > sessions.length) {
    descriptionLines.push(`仅显示最近 ${sessions.length} 个会话；更多会话请使用 /resume <session_id>。`);
  }

  return {
    kind: 'resume',
    title: `恢复会话（最近 ${sessions.length} 条）`,
    description: descriptionLines.join('\n'),
    items: sessions.map((session, index) => ({
      index: index + 1,
      label: formatSessionMenuLabel(session, currentCwd),
      action: { type: 'resume_session', sessionId: session.sessionId, cwd: session.cwd },
    })),
    expiresAt: Date.now(),
  };
}

function buildAgentMenu(chatId: string): MenuContext {
  const currentProvider = chatManager.getProvider(chatId);
  const currentLabel = currentProvider === 'claude'
    ? `当前 agent: Claude（模型: ${config.claude.model}）`
    : '当前 agent: Codex';

  return {
    kind: 'agent',
    title: '选择 Agent',
    description: currentLabel,
    items: [
      {
        index: 1,
        label: `Claude${currentProvider === 'claude' ? '（当前）' : `（模型: ${config.claude.model}）`}`,
        action: { type: 'switch_provider', provider: 'claude' },
      },
      {
        index: 2,
        label: `Codex${currentProvider === 'codex' ? '（当前）' : ''}`,
        action: { type: 'switch_provider', provider: 'codex' },
      },
    ],
    expiresAt: Date.now(),
  };
}

function formatProviderSwitchMessage(provider: AgentProvider, result: { changed: boolean; cwd: string }, resumeSupported: boolean): string {
  const lines = result.changed
    ? [
      `已切换 agent: ${provider}`,
      `工作目录: ${result.cwd}`,
      '当前会话已重置。',
    ]
    : [
      `当前已是 agent: ${provider}`,
      `工作目录: ${result.cwd}`,
    ];

  if (provider === 'claude') {
    lines.splice(1, 0, `模型: ${config.claude.model}`);
  }

  if (!resumeSupported) {
    lines.push('该 agent 暂不支持 /resume。');
  }

  return lines.join('\n');
}

async function executeMenuAction(chatId: string, action: MenuAction): Promise<void> {
  if (action.type === 'resume_session') {
    const result = await resumeSessionTarget(chatId, {
      sessionId: action.sessionId,
      cwd: action.cwd,
    });
    await messageService.sendTextMessage(chatId, result);
    return;
  }

  if (action.type === 'create_cwd') {
    try {
      mkdirSync(action.cwd, { recursive: true });
    } catch (error: any) {
      await messageService.sendTextMessage(chatId, `创建目录失败: ${action.cwd}\n${error.message}`);
      return;
    }

    if (!isDirectoryAvailable(action.cwd)) {
      await messageService.sendTextMessage(chatId, `创建目录失败: ${action.cwd}`);
      return;
    }

    await switchCwd(chatId, action.cwd);
    return;
  }

  if (action.type === 'switch_cwd') {
    if (!isDirectoryAvailable(action.cwd)) {
      await messageService.sendTextMessage(chatId, getInvalidBindingText(action.cwd));
      return;
    }

    await switchCwd(chatId, action.cwd);
    return;
  }

  const result = await chatManager.switchProvider(chatId, action.provider);
  await messageService.sendTextMessage(
    chatId,
    formatProviderSwitchMessage(action.provider, result, chatManager.supportsSessionResume(chatId)),
  );
}

async function switchCwd(chatId: string, cwd: string): Promise<void> {
  await chatManager.switchCwd(chatId, cwd);
  if (chatManager.supportsSessionResume(chatId)) {
    await messageService.sendCardMessage(chatId, chatManager.listSessions(chatId));
  } else {
    await messageService.sendTextMessage(chatId, `已切换工作目录: ${cwd}`);
  }
}

async function handleMenuSelection(chatId: string, text: string): Promise<boolean> {
  const resolved = menuContext.resolve(chatId, text);
  if (!resolved) {
    return false;
  }

  switch (resolved.kind) {
    case 'selected':
      await executeMenuAction(chatId, resolved.action);
      return true;
    case 'cancelled':
      await messageService.sendTextMessage(chatId, '已取消当前选择。');
      return true;
    case 'expired':
      await messageService.sendTextMessage(chatId, '上一个菜单已过期，请重新输入命令。');
      return true;
    case 'invalid': {
      const validChoices = resolved.validChoices.join('、');
      await messageService.sendTextMessage(chatId, `无效编号，请回复 ${validChoices} 或 0。`);
      return true;
    }
    default:
      return false;
  }
}

async function sendMenu(chatId: string, context: Omit<MenuContext, 'expiresAt'>): Promise<void> {
  const activeMenu = menuContext.set(chatId, context);
  await messageService.sendCardMessage(chatId, renderMenu(activeMenu));
}

async function resumeSessionTarget(chatId: string, target: SessionTarget): Promise<string> {
  if (!isDirectoryAvailable(target.cwd)) {
    return getInvalidBindingText(target.cwd);
  }

  await chatManager.switchCwd(chatId, target.cwd);
  return chatManager.resumeSession(chatId, target.sessionId);
}

export function getInvalidStoredBinding(chatId: string): { cwd: string; updatedAt: string } | null {
  const binding = chatBindingStore.get(chatId);
  if (!binding) {
    return null;
  }

  return isDirectoryAvailable(binding.cwd) ? null : binding;
}

export function clearMenuSelection(chatId: string): void {
  menuContext.clear(chatId);
}

export async function handleMessageCommand(
  task: CommandRouteTask,
  options: CommandRouteOptions,
): Promise<CommandRouteResult> {
  const { text, message } = task;
  const chatId = message.chat_id;
  const invalidBinding = getInvalidStoredBinding(chatId);

  if (text.startsWith('/')) {
    clearMenuSelection(chatId);
  }

  if (text === '/help') {
    await messageService.sendTextMessage(chatId, getHelpText(chatId));
    return { kind: 'command' };
  }

  if (text === '/stat') {
    if (invalidBinding) {
      await messageService.sendTextMessage(chatId, getInvalidBindingText(invalidBinding.cwd));
      return { kind: 'command' };
    }

    const activeTaskStatus = options.getActiveTaskStatus(chatId);
    const info = activeTaskStatus
      ? `${chatManager.getDetailedSessionInfo(chatId)}${activeTaskStatus}`
      : chatManager.getDetailedSessionInfo(chatId);
    await messageService.sendTextMessage(chatId, info);
    return { kind: 'command' };
  }

  if (text === '/agent') {
    await sendMenu(chatId, buildAgentMenu(chatId));
    return { kind: 'command' };
  }

  if (text === '/debug') {
    const info = chatManager.getDetailedDebugInfo();
    await messageService.sendCardMessage(chatId, info);
    return { kind: 'command' };
  }

  if (text === '/cd') {
    const menu = buildCwdMenu(chatId);
    if (!menu) {
      await messageService.sendTextMessage(chatId, '暂无 session 目录记录。\n用法: /cd <路径>\n使用 /cd . 切换到根目录');
      return { kind: 'command' };
    }

    await sendMenu(chatId, menu);
    return { kind: 'command' };
  }

  if (text.startsWith('/cd ')) {
    const input = text.slice(4).trim();
    const target = input === '.' ? config.agent.workRoot : resolveWorkPath(input);
    if (!target) {
      if (isSingleSegmentRelativePath(input)) {
        if (!isValidWindowsDirectoryName(input)) {
          await messageService.sendTextMessage(chatId, `目录名不合法: ${input}`);
          return { kind: 'command' };
        }

        const candidate = resolveWorkPathCandidate(input);
        if (!existsSync(candidate)) {
          await sendMenu(chatId, buildCreateCwdMenu(input, candidate));
          return { kind: 'command' };
        }
      }

      await messageService.sendTextMessage(chatId, `目录不存在: ${input}`);
      return { kind: 'command' };
    }

    await switchCwd(chatId, target);
    return { kind: 'command' };
  }

  if (text === '/resume') {
    if (invalidBinding) {
      await messageService.sendTextMessage(chatId, getInvalidBindingText(invalidBinding.cwd));
      return { kind: 'command' };
    }

    if (!chatManager.supportsSessionResume(chatId)) {
      await messageService.sendTextMessage(chatId, chatManager.listSessions(chatId));
      return { kind: 'command' };
    }

    const menu = buildResumeMenu(chatId);
    if (!menu) {
      await messageService.sendCardMessage(chatId, chatManager.listSessions(chatId));
      return { kind: 'command' };
    }

    await sendMenu(chatId, menu);
    return { kind: 'command' };
  }

  if (text.startsWith('/resume ')) {
    if (invalidBinding) {
      await messageService.sendTextMessage(chatId, getInvalidBindingText(invalidBinding.cwd));
      return { kind: 'command' };
    }

    if (!chatManager.supportsSessionResume(chatId)) {
      await messageService.sendTextMessage(chatId, chatManager.listSessions(chatId));
      return { kind: 'command' };
    }

    const input = text.slice(8).trim();
    if (!input) {
      await messageService.sendCardMessage(chatId, chatManager.listSessions(chatId));
      return { kind: 'command' };
    }

    if (/^\d+$/.test(input)) {
      const index = Number(input);
      if (index < 1) {
        await messageService.sendTextMessage(chatId, '编号必须大于 0。');
        return { kind: 'command' };
      }

      const target = chatManager.resolveResumeTarget(chatId, index);
      if (!target) {
        const total = chatManager.getSessionCount(chatId);
        await messageService.sendTextMessage(
          chatId,
          `编号超出范围（共 ${total} 个 session）。\n使用 /resume 查看可用的 sessions。`,
        );
        return { kind: 'command' };
      }

      const result = await resumeSessionTarget(chatId, target);
      await messageService.sendTextMessage(chatId, result);
      return { kind: 'command' };
    }

    const target = chatManager.resolveResumeTargetBySessionId(chatId, input);
    if (!target) {
      await messageService.sendTextMessage(chatId, `会话不存在: ${input}\n使用 /resume 查看可用的 sessions`);
      return { kind: 'command' };
    }

    const result = await resumeSessionTarget(chatId, target);
    await messageService.sendTextMessage(chatId, result);
    return { kind: 'command' };
  }

  if (await handleMenuSelection(chatId, text)) {
    return { kind: 'command' };
  }

  if (text.startsWith('/')) {
    await messageService.sendTextMessage(chatId, `未知命令: ${text.split(' ')[0]}\n输入 /help 查看可用命令。`);
    return { kind: 'command' };
  }

  clearMenuSelection(chatId);

  const reactionId = await messageService.addReaction(message.message_id, 'Typing');
  try {
    await chatManager.sendMessage(chatId, text, {
      onActivity: options.onActivity,
      imagePaths: task.imagePaths,
    });
  } finally {
    options.onActivity?.({
      phase: 'cleanup',
      reason: 'removing typing reaction',
    });
    if (reactionId) {
      await messageService.removeReaction(message.message_id, reactionId).catch(error => {
        logger.error('Failed to remove reaction', {
          messageId: message.message_id,
          chatId,
          error,
        });
      });
    }
  }

  return { kind: 'agent_message' };
}

export function logLongProcessing(startTime: number): boolean {
  return Date.now() - startTime > MESSAGE_IDLE_TIMEOUT_MS * 0.5;
}

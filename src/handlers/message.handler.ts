import { existsSync, mkdirSync } from 'fs';

import { formatAgentRuntimePhase } from '../agent/runtime-status';
import type { ActivityEvent } from '../agent/types';
import { chatManager } from '../bot/chat-manager';
import { resolveChatAccess } from '../bot/chat-access';
import { chatBindingStore } from '../bot/chat-binding-store';
import { ChatWorkloadQueue } from '../bot/chat-workload-queue';
import { deriveChatDirectoryName } from '../bot/directory-name';
import menuContext from '../bot/menu-context';
import {
  getInvalidBindingText,
  getInvalidStoredBinding,
  handleMessageCommand,
  logLongProcessing,
} from '../bot/message-command-router';
import { isDirectoryAvailable, resolveWorkPathCandidate } from '../bot/work-directory';
import config from '../config';
import chatService from '../services/chat.service';
import messageService from '../services/message.service';
import logger from '../utils/logger';
import {
  parseMessageTask,
  type MessageEvent,
  type ParsedMessageTask,
} from './message-intake';
import {
  materializeQueuedTask,
  type QueuedMessageTask,
} from './message-media-materialization';

const processedMessages = new Set<string>();
const MAX_CACHE_SIZE = 500;
let acceptingMessages = true;
const MESSAGE_IDLE_TIMEOUT_MS = readPositiveIntegerEnv('MESSAGE_IDLE_TIMEOUT_MS', 300000);

interface MessageProcessingOptions {
  onActivity?: (event?: ActivityEvent) => void;
}

const workloadQueue = new ChatWorkloadQueue<QueuedMessageTask>({
  describeTask: (task) => ({
    chatId: task.data.message.chat_id,
    messageId: task.data.message.message_id,
    senderId: task.data.sender.sender_id.open_id,
    provider: chatManager.getProvider(task.data.message.chat_id),
    messageType: task.messageType,
    textLength: task.text.length,
    imageCount: task.imagePaths?.length ?? 0,
    enqueuedAt: task.enqueuedAt,
  }),
  processTask: (task, context) => handleQueuedWorkload(task, context.startTime, {
    onActivity: context.onActivity,
  }),
  longRunningNotifier: (chatId, text) => messageService.sendTextMessage(chatId, text),
  longTaskNoticeFirstMs: config.agent.longTaskNoticeFirstMs,
  longTaskNoticeIntervalMs: config.agent.longTaskNoticeIntervalMs,
  longTaskNoticeMaxCount: config.agent.longTaskNoticeMaxCount,
});

function getUnauthorizedText(openId: string): string {
  return `当前账号无权限使用这个机器人。\n你的 open_id: ${openId}\n如需授权，请将它加入 FEISHU_ALLOWED_OPEN_IDS。`;
}

function getIdentityText(data: MessageEvent): string {
  const { sender, message } = data;
  return [
    '当前身份信息:',
    `open_id: ${sender.sender_id.open_id}`,
    `chat_id: ${message.chat_id}`,
    `chat_type: ${message.chat_type ?? 'unknown'}`,
    `message_type: ${message.message_type}`,
  ].join('\n');
}

function getUnboundText(): string {
  return '当前群尚未绑定工作目录，请先使用 /cd <路径> 绑定。';
}

function getResetInvalidBindingText(cwd: string, droppedCount: number): string {
  const droppedSuffix = droppedCount > 0 ? `，已清空 ${droppedCount} 条排队消息` : '';
  return `会话已重置${droppedSuffix}。\n${getInvalidBindingText(cwd)}`;
}

function isDirectChat(chatType: string | undefined): boolean {
  return chatType === 'p2p' || chatType === 'p2p_chat';
}

function isIdentityCommand(text: string): boolean {
  return text === '/whoami' || text === '/openid' || text === '/open_id';
}

function buildAutoBindMessage(
  chatName: string,
  target: string,
  directoryName: string,
  options: { created: boolean; sanitized: boolean; existed: boolean },
): string {
  const lines = [
    options.created
      ? '已根据群名自动创建并绑定工作目录。'
      : '已根据群名自动绑定到现有工作目录。',
    `群名: ${chatName}`,
    `工作目录: ${target}`,
  ];

  if (options.existed) {
    lines.push(`检测到同名目录已存在，已直接绑定: ${directoryName}`);
  } else {
    lines.push(`已创建目录: ${directoryName}`);
  }

  if (options.sanitized) {
    lines.push(`群名已按 Windows 目录规则规范化为: ${directoryName}`);
  }

  return lines.join('\n');
}

function formatTimeoutStatus(chatId: string): string[] {
  const runtimeStatus = chatManager.getRuntimeStatus(chatId);
  if (!runtimeStatus) {
    return [
      '当前状态: 未发现活跃 agent',
      '状态说明: 当前请求可能卡在 agent 之外的收尾流程',
      '执行判断: 当前没有可确认的执行中任务',
    ];
  }

  const lastActivity = runtimeStatus.lastActivityAt
    ? `${formatDuration((Date.now() - runtimeStatus.lastActivityAt) / 1000)}前`
    : '暂无活动记录';

  return [
    `当前状态: ${formatAgentRuntimePhase(runtimeStatus.phase)}`,
    `状态说明: ${runtimeStatus.detail}`,
    `最近活动: ${lastActivity}`,
    `执行判断: ${runtimeStatus.isTurnInProgress ? '仍有任务在执行或等待' : '当前没有执行中的任务'}`,
  ];
}

async function autoBindGroupDirectory(chatId: string): Promise<{ bound: boolean; notified: boolean }> {
  const chatName = await chatService.getChatName(chatId);
  if (!chatName) {
    await messageService.sendTextMessage(
      chatId,
      '当前群尚未绑定工作目录，且读取群名失败，请使用 /cd <路径> 绑定。',
    );
    return { bound: false, notified: true };
  }

  const derived = deriveChatDirectoryName(chatName);
  if (!derived.autoBindable || !derived.directoryName) {
    await messageService.sendTextMessage(
      chatId,
      [
        '当前群尚未绑定工作目录。',
        `群名: ${chatName}`,
        '该群名在按 Windows 目录规则规范化后仍不可用，请使用 /cd <路径> 手动绑定。',
      ].join('\n'),
    );
    return { bound: false, notified: true };
  }

  const target = resolveWorkPathCandidate(derived.directoryName);
  const targetExists = existsSync(target);

  if (targetExists && !isDirectoryAvailable(target)) {
    await messageService.sendTextMessage(
      chatId,
      `群名对应路径已存在但不是目录: ${target}\n请使用 /cd <路径> 手动绑定。`,
    );
    return { bound: false, notified: true };
  }

  if (!targetExists) {
    try {
      mkdirSync(target, { recursive: true });
    } catch (error: any) {
      await messageService.sendTextMessage(chatId, `自动创建目录失败: ${target}\n${error.message}`);
      return { bound: false, notified: true };
    }

    if (!isDirectoryAvailable(target)) {
      await messageService.sendTextMessage(chatId, `自动创建目录失败: ${target}`);
      return { bound: false, notified: true };
    }
  }

  await chatManager.switchCwd(chatId, target);
  await messageService.sendTextMessage(
    chatId,
    buildAutoBindMessage(chatName, target, derived.directoryName, {
      created: !targetExists,
      sanitized: derived.sanitized,
      existed: targetExists,
    }),
  );
  return { bound: true, notified: true };
}

export function handleMessage(data: MessageEvent): Promise<void> {
  return prepareMessageTask(data);
}

async function prepareMessageTask(data: MessageEvent): Promise<void> {
  const { message, sender } = data;
  const chatId = message.chat_id;

  if (!acceptingMessages) {
    logger.warn('Dropping incoming message because handler is stopping', {
      messageId: message.message_id,
      chatId,
    });
    return;
  }

  if (processedMessages.has(message.message_id)) {
    logger.debug('Skipping duplicate message', { messageId: message.message_id });
    return;
  }

  const parsedTask = parseMessageTask(data);
  if (!parsedTask) {
    return;
  }

  rememberProcessedMessage(message.message_id);

  if (parsedTask.messageType === 'text' && isIdentityCommand(parsedTask.text)) {
    await messageService.sendTextMessage(chatId, getIdentityText(data));
    return;
  }

  let binding = chatBindingStore.get(chatId);
  let bindingValid = !binding || isDirectoryAvailable(binding.cwd);
  const hasActiveMenuSelection = /^\d$/.test(parsedTask.text) && menuContext.get(chatId) !== null;

  let access = resolveChatAccess({
    text: parsedTask.text,
    senderOpenId: sender.sender_id.open_id,
    allowedOpenIds: config.feishu.allowedOpenIds,
    binding,
    isDirectChat: isDirectChat(message.chat_type),
    bindingValid,
    hasActiveMenuSelection,
  });

  if (access.kind === 'unauthorized') {
    logger.warn('Rejected message from unauthorized sender', {
      messageId: message.message_id,
      chatId,
      senderOpenId: sender.sender_id.open_id,
      allowedOpenIds: config.feishu.allowedOpenIds,
      chatType: message.chat_type,
      messageType: parsedTask.messageType,
      text: parsedTask.text,
    });
    await messageService.sendTextMessage(chatId, getUnauthorizedText(sender.sender_id.open_id));
    return;
  }

  if (access.kind === 'unbound') {
    const autoBindResult = await autoBindGroupDirectory(chatId);
    if (!autoBindResult.bound) {
      if (!autoBindResult.notified) {
        await messageService.sendTextMessage(chatId, getUnboundText());
      }
      return;
    }

    binding = chatBindingStore.get(chatId);
    bindingValid = !binding || isDirectoryAvailable(binding.cwd);
    access = resolveChatAccess({
      text: parsedTask.text,
      senderOpenId: sender.sender_id.open_id,
      allowedOpenIds: config.feishu.allowedOpenIds,
      binding,
      isDirectChat: isDirectChat(message.chat_type),
      bindingValid,
      hasActiveMenuSelection,
    });
  }

  if (access.kind === 'invalid_binding') {
    await messageService.sendTextMessage(chatId, getInvalidBindingText(binding?.cwd ?? ''));
    return;
  }

  if (parsedTask.messageType === 'text') {
    const controlHandled = await handleControlMessage(parsedTask);
    if (controlHandled) {
      return;
    }
  }

  const task = await materializeQueuedTask(parsedTask);
  if (!task) {
    return;
  }

  workloadQueue.enqueue(task);
}

export async function stopMessageHandling(): Promise<void> {
  acceptingMessages = false;
  logger.info('Stopping message handler', {
    queuedMessages: workloadQueue.getTotalQueuedMessages(),
  });
  await workloadQueue.stop();
  logger.info('Message handler stopped');
}

async function handleImmediateStop(chatId: string): Promise<void> {
  menuContext.clear(chatId);
  const result = await chatManager.interrupt(chatId);

  if (result === 'success') {
    await messageService.sendTextMessage(chatId, '已发送中断信号，AI 将停止当前任务。');
  } else if (result === 'timeout') {
    await messageService.sendTextMessage(chatId, '中断信号发送超时，请使用 /new 强制重置会话。');
  } else if (result === 'no_session') {
    await messageService.sendTextMessage(chatId, '当前没有活跃会话。');
  } else {
    await messageService.sendTextMessage(chatId, '中断失败，请使用 /new 强制重置会话。');
  }
}

async function handleImmediateReset(chatId: string): Promise<void> {
  menuContext.clear(chatId);
  const droppedCount = workloadQueue.clear(chatId);
  await chatManager.interrupt(chatId).catch(() => 'error');
  const invalidBinding = getInvalidStoredBinding(chatId);
  const cwd = await chatManager.reset(chatId);
  if (invalidBinding) {
    await messageService.sendTextMessage(chatId, getResetInvalidBindingText(invalidBinding.cwd, droppedCount));
    return;
  }

  const droppedSuffix = droppedCount > 0 ? `，已清空 ${droppedCount} 条排队消息` : '';
  await messageService.sendTextMessage(chatId, `会话已重置${droppedSuffix}，可以开始新的对话。\n工作目录: ${cwd}`);
}

async function handleImmediateStatus(task: ParsedMessageTask): Promise<void> {
  await handleMessageCommand({
    text: task.text,
    messageType: task.messageType,
    message: task.data.message,
  }, {
    getActiveTaskStatus: chatId => workloadQueue.getActiveTaskStatus(chatId),
  });
}

async function handleControlMessage(task: ParsedMessageTask): Promise<boolean> {
  const { text } = task;
  const chatId = task.data.message.chat_id;
  const hasActiveMenuSelection = /^\d$/.test(text) && menuContext.get(chatId) !== null;

  if (text === '/stop') {
    await handleImmediateStop(chatId);
    return true;
  }

  if (text === '/new') {
    await handleImmediateReset(chatId);
    return true;
  }

  if (text === '/stat') {
    await handleImmediateStatus(task);
    return true;
  }

  if (!text.startsWith('/') && !hasActiveMenuSelection) {
    return false;
  }

  const handled = await handleMessageCommand({
    text,
    messageType: task.messageType,
    message: task.data.message,
  }, {
    getActiveTaskStatus: chatId => workloadQueue.getActiveTaskStatus(chatId),
  });

  return handled.kind === 'command';
}

function rememberProcessedMessage(messageId: string): void {
  processedMessages.add(messageId);
  if (processedMessages.size > MAX_CACHE_SIZE) {
    const first = processedMessages.values().next().value;
    if (first) {
      processedMessages.delete(first);
    }
  }
}

function readPositiveIntegerEnv(name: string, defaultValue: number): number {
  const rawValue = process.env[name];
  if (!rawValue) {
    return defaultValue;
  }

  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    logger.warn('Invalid numeric env value, using default', {
      name,
      rawValue,
      defaultValue,
    });
    return defaultValue;
  }

  return Math.floor(parsed);
}

async function handleQueuedWorkload(
  task: QueuedMessageTask,
  startTime: number,
  options?: MessageProcessingOptions,
): Promise<void> {
  const { data, text } = task;
  const { message } = data;
  const chatId = message.chat_id;

  logger.info('Received chat text', {
    messageId: message.message_id,
    chatId,
    provider: chatManager.getProvider(chatId),
    messageType: task.messageType,
    text,
    textLength: text.length,
    imageCount: task.imagePaths?.length ?? 0,
  });

  return await handleQueuedWorkloadWithIdleWatchdog(task, startTime, options);

  const result = await handleMessageCommand({ ...task, message }, {
    getActiveTaskStatus: chatId => workloadQueue.getActiveTaskStatus(chatId),
    onActivity: options?.onActivity,
  });

  if (result.kind === 'agent_message' && logLongProcessing(startTime)) {
    const duration = Date.now() - startTime;
    logger.warn('Message processing took long time', {
      messageId: message.message_id,
      chatId,
      duration,
      threshold: MESSAGE_IDLE_TIMEOUT_MS * 0.5,
    });

    const statusLines = formatTimeoutStatus(chatId);
    await messageService.sendTextMessage(
      chatId,
      [
        `消息处理超过 ${Math.round(MESSAGE_IDLE_TIMEOUT_MS / 1000)} 秒未观察到新进展，当前不会自动终止会话。`,
        ...statusLines,
        '后续消息会继续排队。',
        '可发送 /stat 查看详细状态；如果确认已经空闲，再考虑使用 /stop 或 /new。',
      ].join('\n'),
    ).catch(error => {
      logger.error('Failed to send timeout notification', { error });
    });
  }
}

async function handleQueuedWorkloadWithIdleWatchdog(
  task: QueuedMessageTask,
  startTime: number,
  options?: MessageProcessingOptions,
): Promise<void> {
  const { data } = task;
  const { message } = data;
  const chatId = message.chat_id;
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  let watchdogSettled = false;
  let lastActivityAt = startTime;
  let activityCount = 0;
  let resolveTimeout: ((result: 'timeout') => void) | null = null;

  const clearWatchdog = () => {
    if (!timeoutTimer) {
      return;
    }

    clearTimeout(timeoutTimer);
    timeoutTimer = undefined;
  };

  const scheduleTimeout = () => {
    if (watchdogSettled) {
      return;
    }

    clearWatchdog();
    timeoutTimer = setTimeout(() => {
      watchdogSettled = true;
      resolveTimeout?.('timeout');
    }, MESSAGE_IDLE_TIMEOUT_MS);

    if (typeof (timeoutTimer as { unref?: () => unknown }).unref === 'function') {
      (timeoutTimer as { unref: () => unknown }).unref();
    }
  };

  const markActivity = (event?: ActivityEvent) => {
    lastActivityAt = Date.now();
    activityCount += 1;
    options?.onActivity?.(event);
    scheduleTimeout();
  };

  const processingPromise = handleMessageCommand({ ...task, message }, {
    getActiveTaskStatus: currentChatId => workloadQueue.getActiveTaskStatus(currentChatId),
    onActivity: markActivity,
  }).finally(() => {
    watchdogSettled = true;
    clearWatchdog();
  });

  const timeoutPromise = new Promise<'timeout'>((resolve) => {
    resolveTimeout = resolve;
    scheduleTimeout();
  });

  const outcome: { kind: 'completed' } | { kind: 'timeout' } = await Promise.race([
    processingPromise.then(() => ({ kind: 'completed' as const })),
    timeoutPromise.then(() => ({ kind: 'timeout' as const })),
  ]);

  if (outcome.kind === 'completed') {
    return;
  }

  const duration = Date.now() - startTime;
  const idleDuration = Date.now() - lastActivityAt;
  logger.error('Message processing idle timeout', {
    messageId: message.message_id,
    chatId,
    duration,
    idleDuration,
    timeout: MESSAGE_IDLE_TIMEOUT_MS,
    activityCount,
  });

  const statusLines = formatTimeoutStatus(chatId);
  await messageService.sendTextMessage(
    chatId,
    [
      `消息处理超过 ${Math.round(MESSAGE_IDLE_TIMEOUT_MS / 1000)} 秒未观察到新进展，当前不会自动终止会话。`,
      ...statusLines,
      '后续消息会继续排队。',
      '可发送 /stat 查看详细状态；如果确认已经空闲，再考虑使用 /stop 或 /new。',
    ].join('\n'),
  ).catch(error => {
    logger.error('Failed to send timeout notification', { error });
  });

  await processingPromise.catch(error => {
    logger.warn('Queued message finished after idle timeout', {
      messageId: message.message_id,
      chatId,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

function formatDuration(seconds: number): string {
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

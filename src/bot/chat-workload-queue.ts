import type { ActivityEvent, ActivityPhase } from '../agent/types';
import type { AgentProvider } from '../config';
import logger from '../utils/logger';
import { formatDuration } from './message-command-router';

export interface ChatWorkloadDescription {
  chatId: string;
  messageId: string;
  senderId: string;
  provider: AgentProvider;
  messageType: string;
  textLength: number;
  imageCount: number;
  enqueuedAt: number;
}

export interface ChatWorkloadProcessorContext {
  startTime: number;
  onActivity: (event?: ActivityEvent) => void;
}

export interface ChatWorkloadQueueOptions<TTask> {
  describeTask: (task: TTask) => ChatWorkloadDescription;
  processTask: (task: TTask, context: ChatWorkloadProcessorContext) => Promise<void>;
  longRunningNotifier?: (chatId: string, text: string) => Promise<void>;
  longTaskNoticeFirstMs?: number;
  longTaskNoticeIntervalMs?: number;
  longTaskNoticeMaxCount?: number;
}

interface ActiveTaskProgress {
  chatId: string;
  messageId: string;
  messageType: string;
  provider: AgentProvider;
  startedAt: number;
  queueDelay: number;
  remainingQueueDepthAtStart: number;
  phase: ActivityPhase;
  reason: string;
  method?: string;
  threadId?: string | null;
  turnId?: string | null;
  lastActivityAt: number;
  activityCount: number;
}

export class ChatWorkloadQueue<TTask> {
  private readonly queuedTasks = new Map<string, TTask[]>();
  private readonly activeProcessors = new Map<string, Promise<void>>();
  private readonly describeTask: (task: TTask) => ChatWorkloadDescription;
  private readonly processTask: (task: TTask, context: ChatWorkloadProcessorContext) => Promise<void>;
  private readonly longRunningNotifier?: (chatId: string, text: string) => Promise<void>;
  private readonly longTaskNoticeFirstMs: number;
  private readonly longTaskNoticeIntervalMs: number;
  private readonly longTaskNoticeMaxCount: number;
  private readonly activeTaskProgress = new Map<string, ActiveTaskProgress>();

  constructor(options: ChatWorkloadQueueOptions<TTask>) {
    this.describeTask = options.describeTask;
    this.processTask = options.processTask;
    this.longRunningNotifier = options.longRunningNotifier;
    this.longTaskNoticeFirstMs = options.longTaskNoticeFirstMs ?? 60 * 1000;
    this.longTaskNoticeIntervalMs = options.longTaskNoticeIntervalMs ?? 3 * 60 * 1000;
    this.longTaskNoticeMaxCount = options.longTaskNoticeMaxCount ?? 5;
  }

  enqueue(task: TTask): number {
    const description = this.describeTask(task);
    const queue = this.queuedTasks.get(description.chatId) ?? [];
    queue.push(task);
    this.queuedTasks.set(description.chatId, queue);
    this.scheduleChatProcessor(description.chatId);

    const queueDepth = this.getChatQueueLength(description.chatId);
    logger.info('Queued incoming message', {
      messageId: description.messageId,
      chatId: description.chatId,
      senderId: description.senderId,
      provider: description.provider,
      messageType: description.messageType,
      textLength: description.textLength,
      imageCount: description.imageCount,
      queueDepth,
    });
    return queueDepth;
  }

  clear(chatId: string): number {
    const queue = this.queuedTasks.get(chatId);
    if (!queue?.length) {
      this.queuedTasks.delete(chatId);
      return 0;
    }

    const droppedCount = queue.length;
    this.queuedTasks.delete(chatId);
    return droppedCount;
  }

  getChatQueueLength(chatId: string): number {
    return this.queuedTasks.get(chatId)?.length ?? 0;
  }

  getTotalQueuedMessages(): number {
    let total = 0;
    for (const queue of this.queuedTasks.values()) {
      total += queue.length;
    }
    return total;
  }

  getActiveTaskStatus(chatId: string): string | null {
    const progress = this.activeTaskProgress.get(chatId);
    if (!progress) {
      return null;
    }

    const now = Date.now();
    const runningDuration = formatDuration((now - progress.startedAt) / 1000);
    const idleDuration = formatDuration((now - progress.lastActivityAt) / 1000);
    const lines = [
      '',
      '当前任务:',
      `- 状态: 运行中`,
      `- 消息类型: ${progress.messageType}`,
      `- 已运行: ${runningDuration}`,
      `- 最近无新进展: ${idleDuration}`,
      `- 当前阶段: ${formatActivityPhase(progress.phase)}`,
      `- 最近进展: ${progress.reason}`,
      `- 进展次数: ${progress.activityCount}`,
      `- 当前排队: ${this.getChatQueueLength(chatId)} 条`,
    ];

    if (progress.method) {
      lines.push(`- 最近事件: ${progress.method}`);
    }
    if (progress.turnId) {
      lines.push(`- Turn: ${progress.turnId.slice(0, 8)}...`);
    }

    return lines.join('\n');
  }

  async stop(): Promise<void> {
    await Promise.all(Array.from(this.activeProcessors.values()));
  }

  private scheduleChatProcessor(chatId: string): void {
    if (this.activeProcessors.has(chatId)) {
      return;
    }

    const processor = this.processChatQueue(chatId).finally(() => {
      this.activeProcessors.delete(chatId);
      if (this.hasQueuedMessages(chatId)) {
        this.scheduleChatProcessor(chatId);
      }
    });

    this.activeProcessors.set(chatId, processor);
  }

  private async processChatQueue(chatId: string): Promise<void> {
    while (true) {
      const task = this.dequeueTask(chatId);
      if (!task) {
        return;
      }

      await this.processQueuedTask(task);
    }
  }

  private dequeueTask(chatId: string): TTask | undefined {
    const queue = this.queuedTasks.get(chatId);
    if (!queue || queue.length === 0) {
      this.queuedTasks.delete(chatId);
      return undefined;
    }

    const task = queue.shift();
    if (!queue.length) {
      this.queuedTasks.delete(chatId);
    }
    return task;
  }

  private hasQueuedMessages(chatId: string): boolean {
    return this.getChatQueueLength(chatId) > 0;
  }

  private async processQueuedTask(task: TTask): Promise<void> {
    const description = this.describeTask(task);
    const startTime = Date.now();
    const queueDelay = startTime - description.enqueuedAt;
    const remainingQueueDepthAtStart = this.getChatQueueLength(description.chatId);
    const progress: ActiveTaskProgress = {
      chatId: description.chatId,
      messageId: description.messageId,
      messageType: description.messageType,
      provider: description.provider,
      startedAt: startTime,
      queueDelay,
      remainingQueueDepthAtStart,
      phase: 'received',
      reason: 'message dequeued',
      lastActivityAt: startTime,
      activityCount: 0,
    };

    logger.info('Processing queued message', {
      messageId: description.messageId,
      chatId: description.chatId,
      senderId: description.senderId,
      provider: description.provider,
      messageType: description.messageType,
      queueDelay,
      imageCount: description.imageCount,
      remainingQueueDepth: remainingQueueDepthAtStart,
    });

    const markActivity = (event?: ActivityEvent) => {
      progress.lastActivityAt = Date.now();
      progress.activityCount += 1;
      if (event) {
        progress.phase = event.phase;
        progress.reason = event.reason;
        progress.method = event.method;
        progress.threadId = event.threadId;
        progress.turnId = event.turnId;
      }
    };

    this.activeTaskProgress.set(description.chatId, progress);
    const longTaskNoticeTimer = this.startLongTaskNoticeTimer(progress);
    try {
      await this.processTask(task, { startTime, onActivity: markActivity });
    } catch (error) {
      const duration = Date.now() - startTime;
      logger.error('Error handling queued message event', {
        messageId: description.messageId,
        chatId: description.chatId,
        duration,
        error,
      });
    } finally {
      longTaskNoticeTimer?.cancel();
      if (this.activeTaskProgress.get(description.chatId) === progress) {
        this.activeTaskProgress.delete(description.chatId);
      }
    }
  }

  private startLongTaskNoticeTimer(progress: ActiveTaskProgress): { cancel: () => void } | null {
    if (
      !this.longRunningNotifier ||
      this.longTaskNoticeFirstMs <= 0 ||
      this.longTaskNoticeIntervalMs <= 0 ||
      this.longTaskNoticeMaxCount <= 0
    ) {
      return null;
    }

    let sentCount = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    const schedule = (delayMs: number) => {
      timer = setTimeout(async () => {
        if (cancelled || this.activeTaskProgress.get(progress.chatId) !== progress) {
          return;
        }

        sentCount += 1;
        try {
          await this.longRunningNotifier?.(progress.chatId, this.formatLongTaskNotice(progress));
        } catch (error) {
          logger.warn('Failed to send long-running task notice', {
            chatId: progress.chatId,
            messageId: progress.messageId,
            error,
          });
        }

        if (!cancelled && sentCount < this.longTaskNoticeMaxCount) {
          schedule(this.longTaskNoticeIntervalMs);
        }
      }, delayMs);

      if (typeof (timer as { unref?: () => unknown }).unref === 'function') {
        (timer as { unref: () => unknown }).unref();
      }
    };

    schedule(this.longTaskNoticeFirstMs);

    return {
      cancel: () => {
        cancelled = true;
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
      },
    };
  }

  private formatLongTaskNotice(progress: ActiveTaskProgress): string {
    const now = Date.now();
    const runningDuration = formatDuration((now - progress.startedAt) / 1000);
    const idleDuration = formatDuration((now - progress.lastActivityAt) / 1000);
    const lines = [
      '这条任务还在处理中，我会继续跟进：',
      `- 已处理时长: ${runningDuration}`,
      `- 距上次进展: ${idleDuration}`,
      `- 当前阶段: ${formatActivityPhase(progress.phase)}`,
      `- 最新进展: ${progress.reason}`,
      `- 当前排队消息: ${this.getChatQueueLength(progress.chatId)} 条`,
    ];

    if (progress.method) {
      lines.push(`- 最近事件: ${progress.method}`);
    }
    if (progress.turnId) {
      lines.push(`- Turn: ${progress.turnId.slice(0, 8)}...`);
    }

    lines.push('- 可发送 /stat 查看详情，或发送 /stop 中断任务。');

    return lines.join('\n');
  }
}

function formatActivityPhase(phase: ActivityPhase): string {
  switch (phase) {
    case 'received':
      return '消息已出队';
    case 'starting':
      return '启动 app-server';
    case 'ready':
      return '会话已就绪';
    case 'turn_starting':
      return '正在启动 turn';
    case 'turn_running':
      return 'turn 运行中';
    case 'turn_finishing':
      return 'turn 收尾中';
    case 'sending_response':
      return '发送回复';
    case 'cleanup':
      return '清理状态';
    default:
      return phase;
  }
}

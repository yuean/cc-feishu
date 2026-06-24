import logger from '../utils/logger';
import messageService from '../services/message.service';
import { createAgent, type CreateAgentOptions } from '../agent/factory';
import type { AgentProvider } from '../config';
import type { ChatAgent, SendMessageOptions } from '../agent/types';
import type { DirectorySummary, SessionSummary, SessionTarget } from '../agent/session-history';
import {
  cloneAgentRuntimeStatus,
  createAgentRuntimeStatus,
  formatAgentRuntimePhase,
  type AgentRuntimeStatus,
} from '../agent/runtime-status';
import {
  appendFeishuAttachmentInstructions,
  hasFeishuAttachmentUploadProtocol,
  parseFeishuResponse,
} from './response-attachments';
import {
  getRecentDirectories as getClaudeRecentDirectories,
  getSessionList as getClaudeSessionList,
  getValidSessions as getClaudeValidSessions,
} from '../claude/session-scanner';
import {
  getRecentDirectories as getCodexRecentDirectories,
  getSessionList as getCodexSessionList,
  getValidSessions as getCodexValidSessions,
} from '../codex/session-scanner';
import config from '../config';
import { chatBindingStore, type ChatBindingStore } from './chat-binding-store';
import {
  decideSession,
  formatSessionDecisionNotice,
  type SessionDecision,
} from './session-decision';

interface ChatData {
  cwd: string;
  provider: AgentProvider;
  sessionId: string | undefined;
  implicitResumeAllowed?: boolean;
  sessionNotified?: boolean;
  lastActiveAt?: number;
  idleReclaimedAt?: number;
}

type AgentFactory = (options: CreateAgentOptions) => ChatAgent;
type TimeoutHandle = ReturnType<typeof setTimeout>;
type SessionDecisionNotifier = (chatId: string, text: string) => Promise<void>;

interface ChatManagerOptions {
  bindingStore?: ChatBindingStore;
  defaultCwd?: string;
  defaultProvider?: AgentProvider;
  agentFactory?: AgentFactory;
  agentIdleTtlMs?: number;
  now?: () => number;
  setTimeoutFn?: (callback: () => void, delayMs: number) => TimeoutHandle;
  clearTimeoutFn?: (handle: TimeoutHandle) => void;
  sessionDayCutoffHour?: number;
  sessionDecisionNotifier?: SessionDecisionNotifier;
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

function formatSessionId(sessionId: string | undefined, maxLength = 16): string {
  if (!sessionId) {
    return '无';
  }

  return sessionId.length > maxLength
    ? `${sessionId.slice(0, maxLength)}...`
    : sessionId;
}

function formatLastActivity(status: AgentRuntimeStatus): string {
  if (!status.lastActivityAt) {
    return '暂无活动记录';
  }

  return `${formatDuration((Date.now() - status.lastActivityAt) / 1000)}前`;
}

function formatRuntimeStatusSummary(status: AgentRuntimeStatus): string {
  const phase = formatAgentRuntimePhase(status.phase);
  const activity = formatLastActivity(status);
  const workload = status.isTurnInProgress ? '仍有任务在执行或等待' : '当前没有执行中的任务';
  return `${phase}｜${status.detail}｜最近活动 ${activity}｜${workload}`;
}

export class ChatManager {
  private chats = new Map<string, ChatData>();
  private agents = new Map<string, ChatAgent>();
  private pendingResponseAttachments = new Map<string, boolean>();
  private readonly bindingStore: ChatBindingStore;
  private readonly defaultCwd: string;
  private readonly defaultProvider: AgentProvider;
  private readonly agentFactory: AgentFactory;
  private readonly startTime: number;
  private readonly agentIdleTtlMs: number;
  private readonly now: () => number;
  private readonly setTimeoutFn: (callback: () => void, delayMs: number) => TimeoutHandle;
  private readonly clearTimeoutFn: (handle: TimeoutHandle) => void;
  private readonly sessionDayCutoffHour: number;
  private readonly sessionDecisionNotifier: SessionDecisionNotifier;
  private readonly idleTimers = new Map<string, TimeoutHandle>();

  constructor(options: ChatManagerOptions = {}) {
    this.bindingStore = options.bindingStore ?? chatBindingStore;
    this.defaultCwd = options.defaultCwd ?? config.agent.workRoot;
    this.defaultProvider = options.defaultProvider ?? config.agent.provider;
    this.agentFactory = options.agentFactory ?? createAgent;
    this.agentIdleTtlMs = options.agentIdleTtlMs ?? config.agent.idleTtlMs;
    this.now = options.now ?? (() => Date.now());
    this.setTimeoutFn = options.setTimeoutFn ?? setTimeout;
    this.clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;
    this.sessionDayCutoffHour = options.sessionDayCutoffHour ?? config.agent.sessionDayCutoffHour;
    this.sessionDecisionNotifier = options.sessionDecisionNotifier
      ?? ((chatId, text) => messageService.sendTextMessage(chatId, text));
    this.startTime = this.now();
  }

  async start(): Promise<void> {
    logger.info('[ChatManager] Started', {
      provider: this.defaultProvider,
      agentIdleTtlMs: this.agentIdleTtlMs,
      sessionDayCutoffHour: this.sessionDayCutoffHour,
    });
  }

  getProvider(chatId?: string): AgentProvider {
    if (!chatId) {
      return this.defaultProvider;
    }
    return this.getChatProvider(chatId);
  }

  getCurrentCwd(chatId: string): string {
    return this.getChatCwd(chatId);
  }

  getRuntimeStatus(chatId: string): AgentRuntimeStatus | null {
    const agent = this.agents.get(chatId);
    const runtimeStatus = agent?.getRuntimeStatus?.();
    return runtimeStatus ? cloneAgentRuntimeStatus(runtimeStatus) : null;
  }

  getDetailedSessionInfo(chatId: string): string {
    const agent = this.agents.get(chatId);
    const data = this.chats.get(chatId);
    const provider = data?.provider ?? this.defaultProvider;

    if (!agent) {
      const cwd = data?.cwd ?? this.getStoredCwd(chatId) ?? this.defaultCwd;
      return [
        '当前没有活跃会话',
        `Provider: ${provider}`,
        `工作目录: ${cwd}`,
        '当前状态: 空闲',
        '状态说明: 尚未创建 agent',
      ].join('\n');
    }

    const runtimeStatus = this.getRuntimeStatus(chatId) ?? createAgentRuntimeStatus();
    const uptime = (this.now() - agent.getStartTime()) / 1000;

    return [
      '会话信息:',
      `- Provider: ${provider}`,
      `- Session ID: ${formatSessionId(agent.getSessionId())}`,
      `- 工作目录: ${agent.getCwd()}`,
      `- 运行时长: ${formatDuration(uptime)}`,
      `- 当前状态: ${formatAgentRuntimePhase(runtimeStatus.phase)}`,
      `- 状态说明: ${runtimeStatus.detail}`,
      `- 最近活动: ${formatLastActivity(runtimeStatus)}`,
      `- 活动计数: ${runtimeStatus.activityCount}`,
      `- 执行判断: ${runtimeStatus.isTurnInProgress ? '仍有任务在执行或等待' : '当前没有执行中的任务'}`,
    ].join('\n');
  }

  getDetailedDebugInfo(): string {
    const uptime = (this.now() - this.startTime) / 1000;
    const info = [
      '**系统状态**',
      `- 默认 Provider: ${this.defaultProvider}`,
      `- 运行时长: ${formatDuration(uptime)}`,
      `- 活跃会话: ${this.chats.size}`,
      `- 活跃 Agent: ${this.agents.size}`,
      '',
      '**会话列表**',
    ];

    if (this.chats.size === 0) {
      info.push('当前没有活跃会话');
      return info.join('\n');
    }

    for (const [chatId, data] of this.chats) {
      const agent = this.agents.get(chatId);
      const lines = [
        `- Chat: \`${chatId.slice(0, 8)}...\``,
        `  - Provider: ${data.provider}`,
        `  - Session: \`${formatSessionId(data.sessionId, 8)}\``,
        `  - CWD: \`${data.cwd}\``,
      ];

      if (!agent) {
        lines.push('  - Agent: 未启动');
      } else {
        const agentId = agent.getAgentId();
        const agentIdShort = agentId.length > 12 ? `${agentId.slice(0, 12)}...` : agentId;
        const runtimeStatus = this.getRuntimeStatus(chatId) ?? createAgentRuntimeStatus();
        lines.push(`  - Agent: \`${agentIdShort}\``);
        lines.push(`  - Status: ${formatRuntimeStatusSummary(runtimeStatus)}`);
      }

      info.push(lines.join('\n'));
    }

    return info.join('\n');
  }

  supportsSessionResume(chatId: string): boolean {
    const provider = this.getChatProvider(chatId);
    return provider === 'claude' || provider === 'codex';
  }

  async sendMessage(chatId: string, text: string, options?: SendMessageOptions): Promise<void> {
    const preparedText = appendFeishuAttachmentInstructions(text);
    const sessionDecision = await this.applySessionDecision(chatId, preparedText);
    const provider = this.getChatProvider(chatId);
    const agent = this.getOrCreateAgent(chatId);
    const allowResponseAttachments = hasFeishuAttachmentUploadProtocol(preparedText);

    this.pendingResponseAttachments.set(chatId, allowResponseAttachments);
    this.cancelIdleTimer(chatId);
    this.touchChat(chatId, agent);
    logger.info('[ChatManager] Sending message', {
      chatId,
      provider,
      agentId: agent.getAgentId(),
      sessionId: agent.getSessionId(),
      sessionDecision,
      messageLength: preparedText.length,
      messageText: preparedText,
      attachmentUploadsEnabled: allowResponseAttachments,
    });
    try {
      await agent.sendMessage(preparedText, options);
    } catch (error) {
      this.pendingResponseAttachments.delete(chatId);
      throw error;
    } finally {
      this.touchChat(chatId, agent);
      this.scheduleIdleReclaim(chatId, agent);
    }
  }

  async interrupt(chatId: string): Promise<'success' | 'timeout' | 'no_session' | 'error'> {
    const agent = this.agents.get(chatId);
    if (!agent) {
      logger.warn('[ChatManager] No agent to interrupt', { chatId });
      return 'no_session';
    }

    try {
      const sent = agent.interrupt();
      const result = sent ? 'success' : 'error';
      logger.info('[ChatManager] Interrupt result', {
        chatId,
        provider: this.getChatProvider(chatId),
        agentId: agent.getAgentId(),
        result,
      });
      return result;
    } catch (error: any) {
      logger.error('[ChatManager] Interrupt failed', { chatId, error: error.message });
      return 'error';
    }
  }

  async switchCwd(chatId: string, newCwd: string): Promise<void> {
    const data = this.chats.get(chatId);
    const currentBindingCwd = this.getStoredCwd(chatId);
    const currentCwd = data?.cwd ?? currentBindingCwd ?? this.defaultCwd;
    const provider = data?.provider ?? this.defaultProvider;
    if (currentCwd === newCwd && currentBindingCwd === newCwd) {
      logger.debug('[ChatManager] Cwd unchanged, skipping switch', { chatId, cwd: newCwd });
      return;
    }

    await this.destroyAgent(chatId, 'switching cwd');
    this.bindingStore.set(chatId, newCwd);
    this.chats.set(chatId, {
      cwd: newCwd,
      provider,
      sessionId: undefined,
      implicitResumeAllowed: true,
      sessionNotified: false,
      lastActiveAt: this.now(),
    });
    logger.info('[ChatManager] Switched cwd', { chatId, oldCwd: currentCwd, newCwd, provider });
  }

  async switchProvider(chatId: string, provider: AgentProvider): Promise<{ changed: boolean; cwd: string }> {
    const data = this.chats.get(chatId);
    const currentProvider = data?.provider ?? this.defaultProvider;
    const cwd = data?.cwd ?? this.getStoredCwd(chatId) ?? this.defaultCwd;

    if (currentProvider === provider) {
      logger.debug('[ChatManager] Provider unchanged, skipping switch', { chatId, provider });
      return { changed: false, cwd };
    }

    await this.destroyAgent(chatId, 'switching provider');
    this.chats.set(chatId, {
      cwd,
      provider,
      sessionId: undefined,
      implicitResumeAllowed: true,
      sessionNotified: false,
      lastActiveAt: this.now(),
    });
    logger.info('[ChatManager] Switched provider', {
      chatId,
      oldProvider: currentProvider,
      newProvider: provider,
      cwd,
    });
    return { changed: true, cwd };
  }

  async reset(chatId: string): Promise<string> {
    await this.destroyAgent(chatId, 'reset');

    const cwd = this.getChatCwd(chatId);
    const provider = this.getChatProvider(chatId);
    this.chats.set(chatId, {
      cwd,
      provider,
      sessionId: undefined,
      implicitResumeAllowed: true,
      sessionNotified: false,
      lastActiveAt: this.now(),
    });
    logger.info('[ChatManager] Session reset', { chatId, cwd, provider });
    return cwd;
  }

  getSessionInfo(chatId: string): string {
    const agent = this.agents.get(chatId);
    const data = this.chats.get(chatId);
    const provider = data?.provider ?? this.defaultProvider;

    if (!agent) {
      const cwd = data?.cwd ?? this.getStoredCwd(chatId) ?? this.defaultCwd;
      return `当前没有活跃会话\nProvider: ${provider}\n工作目录: ${cwd}`;
    }

    const sessionId = agent.getSessionId() || '无';
    const cwd = agent.getCwd();
    const uptime = (this.now() - agent.getStartTime()) / 1000;
    const lastActiveAt = data?.lastActiveAt ?? agent.getStartTime();
    const idleFor = (this.now() - lastActiveAt) / 1000;

    const lines = [
      '会话信息:',
      `- Provider: ${provider}`,
      `- Session ID: ${sessionId === '无' ? sessionId : `${sessionId.slice(0, 16)}...`}`,
      `- 工作目录: ${cwd}`,
      `- 运行时长: ${formatDuration(uptime)}`,
    ];

    if (provider === 'codex') {
      lines.push(
        `- 空闲时长: ${formatDuration(idleFor)}`,
        `- 空闲回收: ${formatDuration(this.agentIdleTtlMs / 1000)}`,
      );
    }

    return lines.join('\n');
  }

  listSessions(chatId: string): string {
    const provider = this.getChatProvider(chatId);
    if (!this.supportsSessionResume(chatId)) {
      const cwd = this.getChatCwd(chatId);
      return [
        `当前 provider: ${provider}`,
        `工作目录: \`${cwd}\``,
        '',
        '当前 provider 暂不支持 /resume 和历史会话列表。',
      ].join('\n');
    }

    const chatData = this.chats.get(chatId);
    const cwd = this.getChatCwd(chatId);
    const sessions = this.getValidSessionsForChat(chatId);
    const totalSessions = this.getSessionCount(chatId);

    if (sessions.length === 0) {
      return `工作目录: \`${cwd}\`\n\n暂无 session 记录`;
    }

    const currentSession = chatData?.sessionId;
    const lines: string[] = [];

    lines.push(`**Sessions（最近 ${sessions.length} 条）**`);
    lines.push(`工作目录: \`${cwd}\``);
    if (cwd === this.defaultCwd) {
      lines.push('当前为默认目录，已显示所有目录的最近会话。');
    }
    if (totalSessions > sessions.length) {
      lines.push(`仅显示最近 ${sessions.length} 条；更多会话请使用 /resume <session_id>。`);
    }
    lines.push('');

    sessions.forEach((session, index) => {
      lines.push(this.formatSessionLine(index + 1, session, currentSession));
      if (session.cwd !== cwd) {
        lines.push(`目录 ${session.cwd}`);
      }
      lines.push(`摘要 ${session.firstMessage}`);
      lines.push('');
    });
    return lines.join('\n');
  }

  getRecentSessions(chatId: string, limit = 9): SessionSummary[] {
    if (!this.supportsSessionResume(chatId)) {
      return [];
    }
    return this.getValidSessionsForChat(chatId, limit);
  }

  getSessionCount(chatId: string): number {
    if (!this.supportsSessionResume(chatId)) {
      return 0;
    }
    return this.getSessionListForChat(chatId).length;
  }

  getRecentDirectories(chatId: string, limit = 9): DirectorySummary[] {
    switch (this.getChatProvider(chatId)) {
      case 'codex':
        return getCodexRecentDirectories(limit);
      case 'claude':
      default:
        return getClaudeRecentDirectories(limit);
    }
  }

  resolveResumeTarget(chatId: string, index: number): SessionTarget | null {
    if (!this.supportsSessionResume(chatId)) {
      return null;
    }

    const sessions = this.getSessionListForChat(chatId);
    if (index < 1 || index > sessions.length) {
      return null;
    }

    const target = sessions[index - 1];
    return {
      sessionId: target.sessionId,
      cwd: target.cwd,
    };
  }

  resolveResumeTargetBySessionId(chatId: string, sessionId: string): SessionTarget | null {
    const normalizedId = sessionId.trim();
    if (!normalizedId) {
      return null;
    }

    return this.getSessionListForChat(chatId).find(item => item.sessionId === normalizedId) ?? null;
  }

  async resumeSession(chatId: string, sessionId: string): Promise<string> {
    const provider = this.getChatProvider(chatId);
    if (!this.supportsSessionResume(chatId)) {
      return `当前 provider (${provider}) 暂不支持 /resume。`;
    }

    const target = this.resolveResumeTargetBySessionId(chatId, sessionId);
    if (!target) {
      return `会话不存在: ${sessionId}\n使用 /resume 查看可用的 sessions`;
    }

    await this.destroyAgent(chatId, 'resuming session');
    this.chats.set(chatId, {
      cwd: target.cwd,
      provider,
      sessionId: target.sessionId,
      implicitResumeAllowed: true,
      sessionNotified: false,
      lastActiveAt: this.now(),
    });

    logger.info('[ChatManager] Resumed session', {
      chatId,
      cwd: target.cwd,
      provider,
      sessionId: target.sessionId,
    });
    return `已切换到 session: ${target.sessionId}\n工作目录: ${target.cwd}`;
  }

  getDebugInfo(): string {
    const uptime = (this.now() - this.startTime) / 1000;
    const info = [
      '**系统状态**',
      `- 默认 Provider: ${this.defaultProvider}`,
      `- 运行时长: ${formatDuration(uptime)}`,
      `- 活跃会话: ${this.chats.size}`,
      `- 活跃 Agent: ${this.agents.size}`,
      '',
      '**会话列表**',
    ];

    if (this.chats.size === 0) {
      info.push('当前没有活跃会话');
    }

    for (const [chatId, data] of this.chats) {
      const agent = this.agents.get(chatId);
      const provider = data.provider;
      let sessionId = data.sessionId || '无';
      if (sessionId !== '无') {
        sessionId = `${sessionId.slice(0, 8)}...`;
      }

      if (agent) {
        const agentId = agent.getAgentId();
        const agentIdShort = agentId.length > 12 ? `${agentId.slice(0, 12)}...` : agentId;
        const status = agent.isInitialized() ? '空闲' : '未连接';
        const lastActiveAt = data.lastActiveAt ?? agent.getStartTime();
        const idleFor = (this.now() - lastActiveAt) / 1000;
        const idleLine = provider === 'codex'
          ? `  - Idle: ${formatDuration(idleFor)} / ${formatDuration(this.agentIdleTtlMs / 1000)}\n`
          : '';

        info.push(
          `- Chat: \`${chatId.slice(0, 8)}...\`\n`
          + `  - Agent: ${status} \`${agentIdShort}\`\n`
          + idleLine
          + `  - Provider: ${provider}\n`
          + `  - Session: \`${sessionId}\`\n`
          + `  - CWD: \`${data.cwd}\``,
        );
      } else {
        const reclaimText = data.idleReclaimedAt
          ? `\n  - 上次空闲回收: ${formatDuration((this.now() - data.idleReclaimedAt) / 1000)}前`
          : '';
        info.push(
          `- Chat: \`${chatId.slice(0, 8)}...\`\n`
          + '  - Agent: 未启动\n'
          + `  - Provider: ${provider}\n`
          + `  - Session: \`${sessionId}\`\n`
          + `  - CWD: \`${data.cwd}\``
          + reclaimText,
        );
      }
    }

    return info.join('\n');
  }

  async stop(): Promise<void> {
    for (const chatId of this.idleTimers.keys()) {
      this.cancelIdleTimer(chatId);
    }
    for (const agent of this.agents.values()) {
      await agent.destroy();
    }
    this.agents.clear();
    logger.info('[ChatManager] Stopped');
  }

  private getOrCreateAgent(chatId: string): ChatAgent {
    let agent = this.agents.get(chatId);
    const provider = this.getChatProvider(chatId);
    if (agent?.isAlive()) {
      logger.debug('[ChatManager] Reusing existing agent', {
        chatId,
        provider,
        agentId: agent.getAgentId(),
        sessionId: agent.getSessionId(),
      });
      return agent;
    }

    if (agent) {
      logger.info('[ChatManager] Cleaning up dead agent', {
        chatId,
        provider,
        agentId: agent.getAgentId(),
        sessionId: agent.getSessionId(),
      });
      agent.destroy().catch(() => {});
      this.agents.delete(chatId);
    }

    const data = this.chats.get(chatId);
    const cwd = data?.cwd ?? this.getStoredCwd(chatId) ?? this.defaultCwd;
    const storedSessionId = data?.sessionId;
    const resumeSessionId = this.supportsSessionResume(chatId) && storedSessionId && data?.implicitResumeAllowed !== false
      ? storedSessionId
      : undefined;

    logger.info('[ChatManager] Creating new agent', {
      chatId,
      provider,
      cwd,
      resumeSessionId,
      willResume: !!resumeSessionId,
    });

    agent = this.agentFactory({
      provider,
      chatId,
      cwd,
      resumeSessionId,
    });
    this.agents.set(chatId, agent);

    const expectedSessionId = resumeSessionId ?? agent.getSessionId();

    agent.onResponse((text) => {
      const allowResponseAttachments = this.pendingResponseAttachments.get(chatId) ?? false;
      this.pendingResponseAttachments.delete(chatId);
      const currentData = this.chats.get(chatId);

      if (currentData && !currentData.sessionNotified) {
        const actualSessionId = agent.getSessionId();
        const sessionChanged = actualSessionId !== expectedSessionId;

        if (sessionChanged || !resumeSessionId) {
          let message = '';
          if (!resumeSessionId) {
            message = `新会话已创建: ${cwd} (${actualSessionId ?? 'pending'})`;
          } else if (sessionChanged) {
            message = `恢复失败，已创建新会话: ${cwd} (${actualSessionId ?? 'pending'})`;
          }

          if (message) {
            messageService.sendTextMessage(chatId, message).catch(() => {});
          }
        }

        this.chats.set(chatId, {
          ...currentData,
          sessionNotified: true,
          sessionId: actualSessionId,
          implicitResumeAllowed: true,
          lastActiveAt: this.now(),
        });
      }

      logger.info('[ChatManager] Agent response received', {
        chatId,
        provider,
        agentId: agent.getAgentId(),
        textLength: text.length,
        responseText: text,
        attachmentUploadsEnabled: allowResponseAttachments,
      });
      this.sendResponse(chatId, text, allowResponseAttachments).catch(error => {
        logger.error('[ChatManager] Failed to send response', { chatId, error });
      });
    });

    agent.onError((error) => {
      this.pendingResponseAttachments.delete(chatId);
      logger.error('[ChatManager] Agent error', { chatId, provider, error: error.message });
      messageService.sendTextMessage(chatId, `错误: ${error.message}`).catch(() => {});
    });

    this.chats.set(chatId, {
      cwd,
      provider,
      sessionId: agent.getSessionId(),
      implicitResumeAllowed: true,
      sessionNotified: false,
      lastActiveAt: this.now(),
    });
    return agent;
  }

  private getChatCwd(chatId: string): string {
    return this.chats.get(chatId)?.cwd ?? this.getStoredCwd(chatId) ?? this.defaultCwd;
  }

  private getChatProvider(chatId: string): AgentProvider {
    return this.chats.get(chatId)?.provider ?? this.defaultProvider;
  }

  private getStoredCwd(chatId: string): string | null {
    return this.bindingStore.get(chatId)?.cwd ?? null;
  }

  private getValidSessionsForChat(chatId: string, limit = 9): SessionSummary[] {
    const cwd = this.getChatCwd(chatId);
    switch (this.getChatProvider(chatId)) {
      case 'codex':
        return getCodexValidSessions(cwd, this.defaultCwd, limit);
      case 'claude':
      default:
        return getClaudeValidSessions(cwd, this.defaultCwd, limit);
    }
  }

  private getSessionListForChat(chatId: string): SessionTarget[] {
    const cwd = this.getChatCwd(chatId);
    switch (this.getChatProvider(chatId)) {
      case 'codex':
        return getCodexSessionList(cwd, this.defaultCwd);
      case 'claude':
      default:
        return getClaudeSessionList(cwd, this.defaultCwd);
    }
  }

  private formatSessionLine(index: number, session: SessionSummary, currentSession?: string): string {
    const marker = session.sessionId === currentSession ? ' 当前' : '';
    const age = formatDuration((this.now() - session.mtimeMs) / 1000);
    return `**${index}.** \`${session.sessionId.slice(0, 8)}...\`${marker}  ${age}前`;
  }

  private async sendResponse(chatId: string, text: string, allowAttachments = false): Promise<void> {
    const parsed = allowAttachments
      ? parseFeishuResponse(text, this.getChatCwd(chatId))
      : { text, attachments: [] };

    if (parsed.text) {
      await this.sendTextResponse(chatId, parsed.text);
    }

    const uploadErrors: string[] = [];
    for (const attachment of parsed.attachments) {
      try {
        if (attachment.kind === 'image') {
          try {
            await messageService.sendImageMessage(chatId, attachment.resolvedPath);
          } catch (imageError) {
            logger.warn('[ChatManager] Falling back to file upload for image attachment', {
              chatId,
              originalPath: attachment.originalPath,
              resolvedPath: attachment.resolvedPath,
              error: imageError instanceof Error ? imageError.message : String(imageError),
            });
            await messageService.sendFileMessage(chatId, attachment.resolvedPath);
          }
        } else {
          await messageService.sendFileMessage(chatId, attachment.resolvedPath);
        }
      } catch (error) {
        logger.error('[ChatManager] Failed to send attachment', {
          chatId,
          kind: attachment.kind,
          originalPath: attachment.originalPath,
          resolvedPath: attachment.resolvedPath,
          error,
        });
        uploadErrors.push(`${attachment.originalPath}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (uploadErrors.length > 0) {
      await messageService.sendTextMessage(
        chatId,
        `以下附件回传失败：\n${uploadErrors.join('\n')}`,
      );
    }
  }

  private async sendTextResponse(chatId: string, text: string): Promise<void> {
    const maxLen = 4000;
    if (text.length <= maxLen) {
      await messageService.sendCardMessage(chatId, text);
      logger.debug('[ChatManager] Response sent', { chatId, textLength: text.length });
      return;
    }

    await this.sendLongMessage(chatId, text, maxLen);
  }

  private async sendLongMessage(chatId: string, text: string, maxLen: number): Promise<void> {
    for (let i = 0; i < text.length; i += maxLen) {
      const chunk = text.slice(i, i + maxLen);
      try {
        await messageService.sendTextMessage(chatId, chunk);
      } catch (err: any) {
        logger.error('[ChatManager] Failed to send chunk', { chatId, error: err.message });
      }
    }
  }

  private async destroyAgent(chatId: string, reason: string): Promise<void> {
    this.cancelIdleTimer(chatId);
    this.pendingResponseAttachments.delete(chatId);
    const agent = this.agents.get(chatId);
    if (!agent) {
      return;
    }

    try {
      await agent.destroy();
    } catch (error: any) {
      logger.error(`[ChatManager] Error destroying agent while ${reason}`, {
        chatId,
        provider: this.getChatProvider(chatId),
        error: error.message,
      });
    }
    this.agents.delete(chatId);
  }

  private async applySessionDecision(chatId: string, text: string): Promise<SessionDecision> {
    const currentData = this.chats.get(chatId);
    const currentAgent = this.agents.get(chatId);
    const hasKnownSession = !!currentData?.sessionId || !!currentAgent?.isAlive();
    const previousAtMs = hasKnownSession
      ? currentData?.lastActiveAt ?? currentAgent?.getStartTime() ?? this.now()
      : undefined;
    const decision = decideSession({
      previousAtMs,
      currentAtMs: this.now(),
      text,
      workdayCutoffHour: this.sessionDayCutoffHour,
      allowImplicitContinue: currentData?.implicitResumeAllowed !== false,
    });

    if (decision.mode === 'new') {
      await this.prepareNewSession(chatId, currentData);
    } else if (decision.reason === 'explicit_continue' && currentData?.implicitResumeAllowed === false) {
      this.chats.set(chatId, {
        ...currentData,
        implicitResumeAllowed: true,
      });
    }

    await this.notifySessionDecision(chatId, decision);
    return decision;
  }

  private async prepareNewSession(chatId: string, currentData: ChatData | undefined): Promise<void> {
    await this.destroyAgent(chatId, 'starting new session by session decision');

    const latestData = this.chats.get(chatId) ?? currentData;
    const cwd = latestData?.cwd ?? this.getStoredCwd(chatId) ?? this.defaultCwd;
    const provider = latestData?.provider ?? this.defaultProvider;

    this.chats.set(chatId, {
      ...latestData,
      cwd,
      provider,
      sessionId: undefined,
      implicitResumeAllowed: true,
      sessionNotified: false,
      idleReclaimedAt: undefined,
      lastActiveAt: latestData?.lastActiveAt,
    });
  }

  private async notifySessionDecision(chatId: string, decision: SessionDecision): Promise<void> {
    const text = formatSessionDecisionNotice(decision);
    if (!text) {
      return;
    }

    try {
      await this.sessionDecisionNotifier(chatId, text);
    } catch (error: any) {
      logger.warn('[ChatManager] Failed to notify session decision', {
        chatId,
        decision,
        error: error.message,
      });
    }
  }

  private touchChat(chatId: string, agent: ChatAgent): void {
    const currentData = this.chats.get(chatId);
    const cwd = currentData?.cwd ?? agent.getCwd();
    const provider = currentData?.provider ?? this.getChatProvider(chatId);
    const sessionId = agent.getSessionId() ?? currentData?.sessionId;

    this.chats.set(chatId, {
      ...currentData,
      cwd,
      provider,
      sessionId,
      implicitResumeAllowed: true,
      lastActiveAt: this.now(),
    });
  }

  private scheduleIdleReclaim(chatId: string, agent: ChatAgent): void {
    this.cancelIdleTimer(chatId);

    if (this.getChatProvider(chatId) !== 'codex' || this.agentIdleTtlMs <= 0 || !agent.isAlive()) {
      return;
    }

    const timer = this.setTimeoutFn(() => {
      void this.reclaimIdleAgent(chatId, agent);
    }, this.agentIdleTtlMs);
    if (typeof (timer as { unref?: () => unknown }).unref === 'function') {
      (timer as { unref: () => unknown }).unref();
    }
    this.idleTimers.set(chatId, timer);
  }

  private cancelIdleTimer(chatId: string): void {
    const timer = this.idleTimers.get(chatId);
    if (!timer) {
      return;
    }

    this.clearTimeoutFn(timer);
    this.idleTimers.delete(chatId);
  }

  private async reclaimIdleAgent(chatId: string, expectedAgent: ChatAgent): Promise<void> {
    this.idleTimers.delete(chatId);

    const agent = this.agents.get(chatId);
    if (!agent || agent !== expectedAgent) {
      return;
    }

    if (!agent.isAlive() || agent.isRunning?.()) {
      this.scheduleIdleReclaim(chatId, agent);
      return;
    }

    const currentData = this.chats.get(chatId);
    const sessionId = agent.getSessionId() ?? currentData?.sessionId;

    logger.info('[ChatManager] Reclaiming idle agent', {
      chatId,
      provider: currentData?.provider ?? this.getChatProvider(chatId),
      agentId: agent.getAgentId(),
      sessionId,
      idleTtlMs: this.agentIdleTtlMs,
    });

    try {
      await agent.destroy();
    } catch (error: any) {
      logger.error('[ChatManager] Error destroying idle agent', {
        chatId,
        provider: currentData?.provider ?? this.getChatProvider(chatId),
        agentId: agent.getAgentId(),
        error: error.message,
      });
      this.scheduleIdleReclaim(chatId, agent);
      return;
    }

    if (this.agents.get(chatId) !== agent) {
      return;
    }

    this.agents.delete(chatId);
    if (currentData) {
      this.chats.set(chatId, {
        ...currentData,
        sessionId,
        implicitResumeAllowed: false,
        lastActiveAt: this.now(),
        idleReclaimedAt: this.now(),
      });
    }
  }
}

export const chatManager = new ChatManager();

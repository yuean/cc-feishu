import { CodexAppServerSpawnTarget } from '../codex/launch';
import {
  cloneAgentRuntimeStatus,
  createAgentRuntimeStatus,
  type AgentRuntimePhase,
  type AgentRuntimeStatus,
} from '../agent/runtime-status';
import type { ActivityEvent, OnActivityCallback } from '../agent/types';
import logger from '../utils/logger';
import { CodexAppServerProcess, CodexAppServerProcessExit } from './app-server-process';
import { CodexAppServerRpcClient } from './app-server-rpc';

export interface CodexMinimalSessionOptions {
  workingDirectory: string;
  codexPathOverride?: string;
  codexArgsPrefix?: string[];
  resumeSessionId?: string;
  developerInstructions?: string | null;
  developerInstructionsProvider?: () => Promise<string | null>;
}

export interface SendMessageResult {
  text: string;
  threadId: string | null;
}

export interface CodexMinimalSendMessageOptions {
  onActivity?: OnActivityCallback;
  imagePaths?: string[];
}

export class ConcurrentTurnError extends Error {
  constructor(message = 'A Codex turn is already in progress for this session.') {
    super(message);
    this.name = 'ConcurrentTurnError';
  }
}

export class TurnAbortedError extends Error {
  constructor(message = 'The current Codex turn was aborted.') {
    super(message);
    this.name = 'TurnAbortedError';
  }
}

type SessionState = 'cold' | 'starting' | 'ready' | 'turn-active' | 'closing' | 'closed' | 'broken';

type TurnInputItem =
  | { type: 'text'; text: string; text_elements: [] }
  | { type: 'localImage'; path: string };

type ActiveTurn = {
  onActivity?: OnActivityCallback;
  turnId: string | null;
  interruptRequested: boolean;
  finalAgentMessage: string | null;
  settled: boolean;
  resolve: (result: SendMessageResult) => void;
  reject: (error: Error) => void;
  promise: Promise<SendMessageResult>;
};

const MAX_START_RETRIES = 1;

export class CodexMinimalSession {
  private readonly workingDirectory: string;
  private readonly codexPathOverride?: string;
  private readonly codexArgsPrefix?: string[];
  private readonly resumeSessionId?: string;
  private readonly developerInstructions: string | null;
  private readonly developerInstructionsProvider?: () => Promise<string | null>;

  private appServerProcess: CodexAppServerProcess | null = null;
  private rpcClient: CodexAppServerRpcClient | null = null;
  private threadId: string | null = null;
  private activeTurnId: string | null = null;
  private state: SessionState = 'cold';
  private activeTurn: ActiveTurn | null = null;
  private inFlightPromise: Promise<SendMessageResult> | null = null;
  private startupPromise: Promise<void> | null = null;
  private closePromise: Promise<void> | null = null;
  private runtimeStatus = createAgentRuntimeStatus({
    phase: 'idle',
    detail: '等待新任务',
  });

  constructor(options: CodexMinimalSessionOptions) {
    this.workingDirectory = options.workingDirectory;
    this.codexPathOverride = options.codexPathOverride;
    this.codexArgsPrefix = options.codexArgsPrefix;
    this.resumeSessionId = options.resumeSessionId;
    this.developerInstructions = normalizeOptionalString(options.developerInstructions);
    this.developerInstructionsProvider = options.developerInstructionsProvider;
  }

  async sendMessage(text: string, options?: CodexMinimalSendMessageOptions): Promise<SendMessageResult> {
    if (this.inFlightPromise) {
      logger.warn('[CodexMinimalSession] Rejecting concurrent turn', {
        workingDirectory: this.workingDirectory,
        threadId: this.threadId,
      });
      throw new ConcurrentTurnError();
    }

    if (this.state === 'closing' || this.state === 'closed') {
      throw new Error('CodexMinimalSession has been closed.');
    }

    if (this.state === 'broken') {
      throw new Error('CodexMinimalSession is broken.');
    }

    logger.info('[CodexMinimalSession] Sending message via app-server', {
      workingDirectory: this.workingDirectory,
      threadId: this.threadId,
      messageLength: text.length,
      messageText: text,
      imageCount: options?.imagePaths?.length ?? 0,
      requestedResumeSessionId: this.resumeSessionId,
      resumeSupported: true,
    });

    const runPromise = this.runTurn(text, options);
    this.inFlightPromise = runPromise;

    try {
      return await runPromise;
    } finally {
      if (this.inFlightPromise === runPromise) {
        this.inFlightPromise = null;
      }
    }
  }

  interrupt(): boolean {
    if (!this.activeTurnId || !this.rpcClient || !this.threadId) {
      logger.warn('[CodexMinimalSession] No active turn to interrupt', {
        workingDirectory: this.workingDirectory,
        threadId: this.threadId,
        activeTurnId: this.activeTurnId,
      });
      return false;
    }

    logger.info('[CodexMinimalSession] Interrupting active turn', {
      workingDirectory: this.workingDirectory,
      threadId: this.threadId,
      turnId: this.activeTurnId,
    });

    if (this.activeTurn) {
      this.activeTurn.interruptRequested = true;
    }
    this.setRuntimeStatus('已发送中断请求，等待 Codex 停止', 'interrupting', true);

    const threadId = this.threadId;
    const turnId = this.activeTurnId;
    void this.rpcClient.request('turn/interrupt', {
      threadId,
      turnId,
    }).catch((error) => {
      logger.warn('[CodexMinimalSession] turn/interrupt request failed', {
        workingDirectory: this.workingDirectory,
        threadId,
        turnId,
        error: asError(error, 'turn/interrupt failed'),
      });
    });
    return true;
  }

  isRunning(): boolean {
    return this.inFlightPromise !== null;
  }

  getRuntimeStatus(): AgentRuntimeStatus {
    return cloneAgentRuntimeStatus(this.runtimeStatus);
  }

  getThreadId(): string | null {
    return this.threadId;
  }

  async close(): Promise<void> {
    if (this.closePromise) {
      return await this.closePromise;
    }

    this.closePromise = this.closeInternal();
    return await this.closePromise;
  }

  async destroy(): Promise<void> {
    await this.close();
  }

  private async closeInternal(): Promise<void> {
    if (this.state === 'closed') {
      return;
    }

    this.state = 'closing';
    this.setRuntimeStatus('正在关闭 Codex 会话', this.activeTurn ? 'interrupting' : 'idle', !!this.activeTurn);
    const process = this.appServerProcess;

    if (!process) {
      this.rpcClient?.closeAllPending(new Error('CodexMinimalSession closed.'));
      this.rpcClient = null;
      this.activeTurnId = null;
      this.activeTurn = null;
      this.state = 'closed';
      return;
    }

    try {
      await process.stop();
    } finally {
      this.rpcClient?.closeAllPending(new Error('CodexMinimalSession closed.'));
      this.rpcClient = null;
      this.appServerProcess = null;
      this.activeTurnId = null;
      if (this.activeTurn && !this.activeTurn.settled) {
        this.rejectTurn(this.activeTurn, new Error('CodexMinimalSession closed.'));
      }
      this.activeTurn = null;
      this.state = 'closed';
    }
  }

  private async runTurn(text: string, options?: CodexMinimalSendMessageOptions): Promise<SendMessageResult> {
    await this.ensureStarted();

    if (!this.rpcClient || !this.threadId) {
      throw new Error('Codex app-server session failed to initialize.');
    }

    const activeTurn = this.createActiveTurn(options?.onActivity);
    this.activeTurn = activeTurn;
    this.activeTurnId = null;
    this.state = 'turn-active';
    const input = buildThreadInput(text, options?.imagePaths);

    this.markActivity('Codex 正在接收本轮输入', options?.onActivity, 'running', true);
    notifyActivity(options?.onActivity, {
      phase: 'turn_starting',
      reason: 'sending turn/start',
      threadId: this.threadId,
    });

    logger.info('[CodexMinimalSession] Starting turn/start', {
      workingDirectory: this.workingDirectory,
      threadId: this.threadId,
      messageLength: text.length,
      messageText: text,
      imageCount: options?.imagePaths?.length ?? 0,
    });

    try {
      await this.rpcClient.request('turn/start', {
        threadId: this.threadId,
        approvalPolicy: 'never',
        input,
      });
    } catch (error) {
      const turnError = asError(error, 'turn/start failed');
      this.rejectTurn(activeTurn, turnError);
    }

    try {
      return await activeTurn.promise;
    } finally {
      if (this.activeTurn === activeTurn) {
        this.activeTurn = null;
      }
      if (canReturnToReadyState(this.state)) {
        this.state = 'ready';
      }
      this.activeTurnId = null;
    }
  }

  private async ensureStarted(): Promise<void> {
    if (this.state === 'ready' || this.state === 'turn-active') {
      return;
    }

    if (this.state === 'closing' || this.state === 'closed') {
      throw new Error('CodexMinimalSession has been closed.');
    }

    if (this.state === 'broken') {
      throw new Error('CodexMinimalSession is broken.');
    }

    if (this.startupPromise) {
      await this.startupPromise;
      return;
    }

    this.startupPromise = this.startWithRetry();
    try {
      await this.startupPromise;
    } finally {
      if (this.startupPromise) {
        this.startupPromise = null;
      }
    }
  }

  private async startWithRetry(): Promise<void> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= MAX_START_RETRIES; attempt += 1) {
      try {
        await this.startOnce(attempt + 1);
        return;
      } catch (error) {
        lastError = asError(error, 'Failed to start Codex app-server session.');
        logger.error('[CodexMinimalSession] Failed to initialize app-server session', {
          workingDirectory: this.workingDirectory,
          attempt: attempt + 1,
          maxAttempts: MAX_START_RETRIES + 1,
          error: lastError,
        });
        this.setRuntimeStatus(lastError.message, 'error', false);
        await this.resetTransportAfterStartupFailure();

        if (attempt >= MAX_START_RETRIES) {
          this.state = 'broken';
          throw lastError;
        }
      }
    }

    this.state = 'broken';
    throw lastError ?? new Error('Failed to start Codex app-server session.');
  }

  private async startOnce(attempt: number): Promise<void> {
    this.state = 'starting';
    this.setRuntimeStatus('正在启动 Codex app-server', 'initializing', false);
    const appServerProcess = new CodexAppServerProcess({
      cwd: this.workingDirectory,
      spawnTarget: resolveSpawnTarget(this.codexPathOverride, this.codexArgsPrefix),
    });
    appServerProcess.start();

    const rpcClient = new CodexAppServerRpcClient({
      stdin: appServerProcess.stdin,
    });

    appServerProcess.onLine((line) => {
      rpcClient.handleLine(line);
      this.handleAppServerLine(line);
    });
    appServerProcess.onExit((exit) => {
      this.handleProcessExit(appServerProcess, rpcClient, exit);
    });

    this.appServerProcess = appServerProcess;
    this.rpcClient = rpcClient;

    logger.info('[CodexMinimalSession] Initializing app-server session', {
      workingDirectory: this.workingDirectory,
      attempt,
      codexPathOverride: this.codexPathOverride,
      codexArgsPrefix: this.codexArgsPrefix,
    });
    notifyActivity(this.activeTurn?.onActivity, {
      phase: 'starting',
      reason: 'app-server process started',
      threadId: this.threadId,
    });

    await rpcClient.request('initialize', {
      clientInfo: {
        name: 'cc-feishu-typescript',
        version: '1.0.0',
      },
      capabilities: {
        experimentalApi: true,
      },
    });

    rpcClient.notify('initialized');

    if (this.resumeSessionId) {
      await rpcClient.request('thread/resume', {
        threadId: this.resumeSessionId,
        cwd: this.workingDirectory,
        approvalPolicy: 'never',
        sandbox: 'danger-full-access',
      });
    } else {
      const threadStartParams: Record<string, unknown> = {
        cwd: this.workingDirectory,
        approvalPolicy: 'never',
        sandbox: 'danger-full-access',
      };
      const developerInstructions = await this.resolveDeveloperInstructions();

      if (developerInstructions) {
        threadStartParams.developerInstructions = developerInstructions;
      }

      await rpcClient.request('thread/start', threadStartParams);
    }

    const threadId = rpcClient.getThreadId();
    if (!threadId) {
      throw new Error('Codex thread initialization did not return a threadId.');
    }

    this.threadId = threadId;
    this.state = 'ready';
    this.setRuntimeStatus('Codex 会话已就绪，等待新任务', 'idle', false);
    notifyActivity(this.activeTurn?.onActivity, {
      phase: 'ready',
      reason: this.resumeSessionId ? 'thread resumed' : 'thread started',
      threadId: this.threadId,
    });

    logger.info('[CodexMinimalSession] App-server session ready', {
      workingDirectory: this.workingDirectory,
      threadId: this.threadId,
      attempt,
      resumed: !!this.resumeSessionId,
      requestedResumeSessionId: this.resumeSessionId,
    });
  }

  private async resetTransportAfterStartupFailure(): Promise<void> {
    const process = this.appServerProcess;
    const rpcClient = this.rpcClient;

    this.appServerProcess = null;
    this.rpcClient = null;
    this.activeTurnId = null;
    this.threadId = null;
    this.activeTurn = null;

    rpcClient?.closeAllPending(new Error('Codex app-server startup failed.'));

    if (process) {
      try {
        await process.stop();
      } catch (error) {
        logger.warn('[CodexMinimalSession] Failed to stop app-server after startup failure', {
          workingDirectory: this.workingDirectory,
          error,
        });
      }
    }

    if (this.state !== 'broken') {
      this.state = 'cold';
      this.setRuntimeStatus('等待重新建立 Codex 会话', 'idle', false);
    }
  }

  private handleProcessExit(
    appServerProcess: CodexAppServerProcess,
    rpcClient: CodexAppServerRpcClient,
    exit: CodexAppServerProcessExit,
  ): void {
    const exitError = buildProcessExitError(exit, appServerProcess.getStderrTail());
    rpcClient.closeAllPending(exitError);

    if (this.appServerProcess !== appServerProcess) {
      return;
    }

    this.appServerProcess = null;
    this.rpcClient = null;
    this.activeTurnId = null;

    if (this.activeTurn && !this.activeTurn.settled) {
      this.rejectTurn(this.activeTurn, exitError);
      this.activeTurn = null;
    }

    if (this.state === 'closing' || this.state === 'closed') {
      this.state = 'closed';
      return;
    }

    this.state = 'broken';
    this.setRuntimeStatus(exitError.message, 'error', false);

    logger.error('[CodexMinimalSession] app-server exited and session is now broken', {
      workingDirectory: this.workingDirectory,
      threadId: this.threadId,
      exit,
      stderrTail: appServerProcess.getStderrTail(),
    });
  }

  private handleAppServerLine(line: string): void {
    const message = parseJsonLine(line);
    if (!message || typeof message.method !== 'string') {
      return;
    }

    const method = message.method;
    const params = isObjectRecord(message.params) ? message.params : {};

    if (method === 'turn/started' && this.threadId && isCurrentThreadNotification(params, this.threadId)) {
      const turnId = extractTurnId(params) ?? this.rpcClient?.getTurnId() ?? null;
      this.activeTurnId = turnId;
      if (this.activeTurn) {
        this.activeTurn.turnId = turnId;
      }
    }

    if (this.activeTurn && isCurrentThreadActivity(method, params, this.threadId)) {
      notifyActivity(this.activeTurn.onActivity, {
        phase: getActivityPhaseForMethod(method),
        reason: describeActivity(method, params),
        method,
        threadId: this.threadId,
        turnId: extractTurnId(params) ?? this.activeTurn.turnId,
      });

      const { detail, phase } = describeCodexRuntimeNotification(method, params);
      this.markActivity(detail, this.activeTurn.onActivity, phase, true);
    }

    if (!this.threadId || !isCurrentThreadNotification(params, this.threadId)) {
      return;
    }

    if (method === 'turn/started') {
      return;
    }

    if (method === 'item/completed') {
      if (!this.activeTurn) {
        return;
      }

      const finalAgentMessage = extractFinalAgentMessage(params);
      if (finalAgentMessage) {
        this.activeTurn.finalAgentMessage = finalAgentMessage;
      }
      return;
    }

    if (method !== 'turn/completed' || !this.activeTurn) {
      return;
    }

    const turnStatus = extractTurnStatus(params);
    const turnError =
      extractTurnError(params) ??
      extractItemError(params) ??
      this.rpcClient?.getTurnError() ??
      null;

    if (this.activeTurn.interruptRequested && isAbortedTurnStatus(turnStatus)) {
      this.setRuntimeStatus('Codex 当前任务已中断', 'interrupted', false, true);
      this.rejectTurn(this.activeTurn, new TurnAbortedError());
      return;
    }

    if (turnError) {
      this.setRuntimeStatus(turnError, 'error', false);
      this.rejectTurn(this.activeTurn, new Error(turnError));
      return;
    }

    if (turnStatus !== 'completed') {
      const error = new Error(`Codex turn ended with status ${turnStatus ?? 'unknown'}.`);
      this.setRuntimeStatus(error.message, 'error', false);
      this.rejectTurn(this.activeTurn, error);
      return;
    }

    this.setRuntimeStatus('Codex 本轮已完成，等待消息发送收尾', 'idle', false, true);
    this.resolveTurn(this.activeTurn, {
      text: this.activeTurn.finalAgentMessage ?? '',
      threadId: this.threadId,
    });
  }

  private createActiveTurn(onActivity?: OnActivityCallback): ActiveTurn {
    let resolveTurnPromise: ((result: SendMessageResult) => void) | null = null;
    let rejectTurnPromise: ((error: Error) => void) | null = null;

    const promise = new Promise<SendMessageResult>((resolve, reject) => {
      resolveTurnPromise = resolve;
      rejectTurnPromise = reject;
    });

    if (!resolveTurnPromise || !rejectTurnPromise) {
      throw new Error('Failed to create active Codex turn promise.');
    }

    return {
      onActivity,
      turnId: null,
      interruptRequested: false,
      finalAgentMessage: null,
      settled: false,
      resolve: resolveTurnPromise,
      reject: rejectTurnPromise,
      promise,
    };
  }

  private resolveTurn(turn: ActiveTurn, result: SendMessageResult): void {
    if (turn.settled) {
      return;
    }

    turn.settled = true;
    turn.resolve(result);
  }

  private rejectTurn(turn: ActiveTurn, error: Error): void {
    if (turn.settled) {
      return;
    }

    turn.settled = true;
    turn.reject(error);
  }

  private async resolveDeveloperInstructions(): Promise<string | null> {
    if (this.developerInstructionsProvider) {
      return normalizeOptionalString(await this.developerInstructionsProvider());
    }

    return this.developerInstructions;
  }

  private setRuntimeStatus(
    detail: string,
    phase: AgentRuntimePhase,
    isTurnInProgress: boolean,
    syncLastActivityAt = false,
  ): void {
    const now = Date.now();
    this.runtimeStatus = {
      ...this.runtimeStatus,
      phase,
      detail,
      isTurnInProgress,
      updatedAt: now,
      lastActivityAt: syncLastActivityAt ? now : this.runtimeStatus.lastActivityAt,
    };
  }

  private markActivity(
    detail: string,
    onActivity: OnActivityCallback | undefined,
    phase: AgentRuntimePhase,
    isTurnInProgress: boolean,
  ): void {
    const now = Date.now();
    this.runtimeStatus = {
      ...this.runtimeStatus,
      phase,
      detail,
      isTurnInProgress,
      updatedAt: now,
      lastActivityAt: now,
      activityCount: this.runtimeStatus.activityCount + 1,
    };
    notifyActivity(onActivity, {
      phase: 'turn_running',
      reason: detail,
      threadId: this.threadId,
      turnId: this.activeTurnId,
    });
  }
}

function notifyActivity(onActivity: OnActivityCallback | undefined, event: ActivityEvent): void {
  if (!onActivity) {
    return;
  }

  try {
    onActivity(event);
  } catch (error) {
    logger.warn('[CodexMinimalSession] Activity callback failed', { error });
  }
}

function getActivityPhaseForMethod(method: string): ActivityEvent['phase'] {
  if (method === 'turn/started') {
    return 'turn_running';
  }

  if (method === 'turn/completed') {
    return 'turn_finishing';
  }

  return 'turn_running';
}

function describeActivity(method: string, params: Record<string, unknown>): string {
  if (method === 'turn/started') {
    return 'turn started';
  }

  if (method === 'turn/completed') {
    const status = extractTurnStatus(params);
    return status ? `turn completed (${status})` : 'turn completed';
  }

  if (method === 'item/completed') {
    const item = params.item;
    if (isObjectRecord(item)) {
      const type = normalizeString(item.type);
      return type ? `item completed (${type})` : 'item completed';
    }
  }

  if (method === 'item/started') {
    const item = params.item;
    if (isObjectRecord(item)) {
      const type = normalizeString(item.type);
      return type ? `item started (${type})` : 'item started';
    }
  }

  return method;
}

function describeCodexRuntimeNotification(
  method: string,
  params: Record<string, unknown>,
): { detail: string; phase: AgentRuntimePhase } {
  if (method === 'turn/started') {
    return {
      detail: 'Codex 已开始处理当前轮次',
      phase: 'running',
    };
  }

  if (method === 'turn/completed') {
    return {
      detail: 'Codex 已完成本轮处理，正在收尾',
      phase: 'running',
    };
  }

  if (method === 'item/started' || method === 'item/completed') {
    return describeCodexRuntimeItem(params.item, method === 'item/started');
  }

  return {
    detail: `Codex 事件更新: ${method}`,
    phase: 'running',
  };
}

function describeCodexRuntimeItem(item: unknown, started: boolean): { detail: string; phase: AgentRuntimePhase } {
  if (!item || typeof item !== 'object') {
    return {
      detail: started ? 'Codex 正在处理子步骤' : 'Codex 已完成一个子步骤',
      phase: 'running',
    };
  }

  const record = item as Record<string, unknown>;
  const itemType = typeof record.type === 'string' ? record.type : 'unknown';
  const itemName = typeof record.name === 'string' ? record.name : '';

  if (itemType === 'reasoning') {
    return {
      detail: started ? 'Codex 正在思考' : 'Codex 思考步骤已更新',
      phase: 'running',
    };
  }

  if (itemType === 'agentMessage') {
    return {
      detail: started ? 'Codex 正在生成回复' : 'Codex 回复内容已更新',
      phase: 'running',
    };
  }

  if (itemType === 'function_call') {
    return {
      detail: started
        ? `Codex 正在调用工具 ${itemName || 'unknown'}`
        : `工具 ${itemName || 'unknown'} 已返回，等待 Codex 继续`,
      phase: started ? 'waiting' : 'running',
    };
  }

  if (itemType === 'function_call_output') {
    return {
      detail: '工具输出已返回，等待 Codex 继续处理',
      phase: 'running',
    };
  }

  return {
    detail: started ? `Codex 正在处理 ${itemType}` : `Codex 已完成 ${itemType}`,
    phase: 'running',
  };
}

function buildThreadInput(text: string, imagePaths?: string[]): TurnInputItem[] {
  const sanitizedImagePaths = (imagePaths ?? []).filter(Boolean);
  const items: TurnInputItem[] = [
    { type: 'text', text, text_elements: [] },
  ];

  for (const imagePath of sanitizedImagePaths) {
    items.push({ type: 'localImage', path: imagePath });
  }

  return items;
}

function normalizeOptionalString(value: string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  const trimmedValue = value.trim();
  return trimmedValue || null;
}

function resolveSpawnTarget(
  codexPathOverride?: string,
  codexArgsPrefix?: string[],
): CodexAppServerSpawnTarget | undefined {
  if (!codexPathOverride && (!codexArgsPrefix || codexArgsPrefix.length === 0)) {
    return undefined;
  }

  if (codexArgsPrefix && codexArgsPrefix.length > 0) {
    throw new Error('codexArgsPrefix is not supported for codex app-server sessions.');
  }

  if (!codexPathOverride) {
    return undefined;
  }

  if (process.platform === 'win32') {
    return {
      command: 'cmd.exe',
      args: ['/d', '/s', '/c', codexPathOverride, 'app-server'],
      launchDescription: `cmd.exe trampoline (${codexPathOverride} app-server)`,
    };
  }

  return {
    command: codexPathOverride,
    args: ['app-server'],
    launchDescription: `direct spawn (${codexPathOverride} app-server)`,
  };
}

function parseJsonLine(line: string): Record<string, unknown> | null {
  const trimmedLine = line.trim();
  if (!trimmedLine) {
    return null;
  }

  try {
    const value = JSON.parse(trimmedLine) as unknown;
    return isObjectRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function isCurrentThreadActivity(
  method: string,
  params: Record<string, unknown>,
  threadId: string | null,
): boolean {
  if (!threadId) {
    return false;
  }

  if (!method.startsWith('turn/') && !method.startsWith('item/')) {
    return false;
  }

  return normalizeString(params.threadId) === threadId;
}

function isCurrentThreadNotification(params: Record<string, unknown>, threadId: string): boolean {
  const paramsThreadId = normalizeString(params.threadId);
  return paramsThreadId === null || paramsThreadId === threadId;
}

function extractTurnId(params: Record<string, unknown>): string | null {
  const turn = params.turn;
  if (!isObjectRecord(turn)) {
    return null;
  }

  return normalizeString(turn.id);
}

function extractTurnStatus(params: Record<string, unknown>): string | null {
  const directStatus = normalizeString(params.status);
  if (directStatus) {
    return directStatus;
  }

  const turn = params.turn;
  if (!isObjectRecord(turn)) {
    return null;
  }

  return normalizeString(turn.status);
}

function extractTurnError(params: Record<string, unknown>): string | null {
  const directError = extractErrorMessage(params.error);
  if (directError) {
    return directError;
  }

  const turn = params.turn;
  if (!isObjectRecord(turn)) {
    return null;
  }

  return extractErrorMessage(turn.error);
}

function extractItemError(params: Record<string, unknown>): string | null {
  const item = params.item;
  if (!isObjectRecord(item) || item.type !== 'error') {
    return null;
  }

  return normalizeString(item.text) ?? normalizeString(item.message);
}

function extractFinalAgentMessage(params: Record<string, unknown>): string | null {
  const item = params.item;
  if (!isObjectRecord(item) || item.type !== 'agentMessage') {
    return null;
  }

  const phase = normalizeString(item.phase);
  if (phase && phase !== 'final_answer') {
    return null;
  }

  const text = collectText(item).join(' ').trim();
  return text || null;
}

function collectText(value: unknown): string[] {
  if (typeof value === 'string') {
    return [value];
  }

  if (!value || typeof value !== 'object') {
    return [];
  }

  if (Array.isArray(value)) {
    return value.flatMap(entry => collectText(entry));
  }

  const objectValue = value as Record<string, unknown>;
  const collected: string[] = [];

  for (const [key, entry] of Object.entries(objectValue)) {
    if (key === 'text' && typeof entry === 'string') {
      collected.push(entry);
      continue;
    }

    if (key === 'content' || key === 'message' || key === 'parts') {
      collected.push(...collectText(entry));
    }
  }

  return collected;
}

function extractErrorMessage(value: unknown): string | null {
  if (!isObjectRecord(value)) {
    return null;
  }

  return normalizeString(value.message);
}

function normalizeString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function canReturnToReadyState(state: SessionState): boolean {
  return state !== 'broken' && state !== 'closing' && state !== 'closed';
}

function isAbortedTurnStatus(status: string | null): boolean {
  return status === 'cancelled' || status === 'canceled' || status === 'aborted' || status === 'interrupted';
}

function buildProcessExitError(exit: CodexAppServerProcessExit, stderrTail: string): Error {
  const messageParts = [
    `Codex app-server exited with code=${exit.code ?? 'null'} signal=${exit.signal ?? 'null'}.`,
  ];

  if (stderrTail) {
    messageParts.push(`stderr tail: ${stderrTail}`);
  }

  return new Error(messageParts.join(' '));
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object';
}

function asError(error: unknown, fallbackMessage: string): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error(fallbackMessage);
}

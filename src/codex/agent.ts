import logger from '../utils/logger';
import type { AgentRuntimeStatus } from '../agent/runtime-status';
import type { ChatAgent, OnErrorCallback, OnResponseCallback, SendMessageOptions } from '../agent/types';
import {
  CodexMinimalSession,
  ConcurrentTurnError,
  TurnAbortedError,
} from '../codex-minimal/session';
import { resolveCodexDeveloperInstructions } from './developer-instructions';
import { resolveLegacyCodexLaunchOverrides } from './launch';

let agentCounter = 0;

export class CodexAgent implements ChatAgent {
  private readonly agentId: string;
  private readonly chatId: string;
  private readonly cwd: string;
  private readonly session: CodexMinimalSession;
  private readonly startTime: number;
  private destroyed = false;
  private initialized = false;
  private onResponseCallback: OnResponseCallback | null = null;
  private onErrorCallback: OnErrorCallback | null = null;

  constructor(chatId: string, cwd: string, resumeSessionId?: string) {
    this.agentId = `codex${++agentCounter}`;
    this.chatId = chatId;
    this.cwd = cwd;
    this.startTime = Date.now();

    const launchConfig = resolveLegacyCodexLaunchOverrides();
    this.session = new CodexMinimalSession({
      workingDirectory: cwd,
      codexPathOverride: launchConfig.executablePath,
      codexArgsPrefix: launchConfig.argsPrefix,
      resumeSessionId,
      developerInstructionsProvider: () => resolveCodexDeveloperInstructions(this.chatId),
    });

    logger.info('[CodexAgent] Creating agent', {
      chatId,
      agentId: this.agentId,
      cwd,
      codexPathOverride: launchConfig.executablePath,
      codexArgsPrefix: launchConfig.argsPrefix,
      requestedResumeSessionId: resumeSessionId,
      resumeSupported: true,
    });
  }

  async sendMessage(text: string, options?: SendMessageOptions): Promise<void> {
    if (this.destroyed) {
      logger.warn('[CodexAgent] Cannot send message, agent destroyed', {
        chatId: this.chatId,
        agentId: this.agentId,
      });
      return;
    }

    logger.info('[CodexAgent] Sending message', {
      chatId: this.chatId,
      agentId: this.agentId,
      messageLength: text.length,
      messageText: text,
    });

    try {
      const result = await this.session.sendMessage(text, options);
      this.initialized = true;
      logger.info('[CodexAgent] Received response', {
        chatId: this.chatId,
        agentId: this.agentId,
        threadId: result.threadId,
        textLength: result.text.length,
        responseText: result.text,
      });
      this.onResponseCallback?.(result.text);
    } catch (error) {
      if (error instanceof TurnAbortedError) {
        logger.info('[CodexAgent] Turn aborted', {
          chatId: this.chatId,
          agentId: this.agentId,
          threadId: this.getSessionId(),
        });
        return;
      }

      if (error instanceof ConcurrentTurnError) {
        logger.warn('[CodexAgent] Concurrent turn rejected', {
          chatId: this.chatId,
          agentId: this.agentId,
        });
      }

      await this.destroy(error as Error);
      throw error;
    }
  }

  interrupt(): boolean {
    if (this.destroyed) {
      logger.warn('[CodexAgent] Cannot interrupt, agent destroyed', {
        chatId: this.chatId,
        agentId: this.agentId,
      });
      return false;
    }

    logger.info('[CodexAgent] Interrupting', {
      chatId: this.chatId,
      agentId: this.agentId,
      threadId: this.getSessionId(),
    });

    return this.session.interrupt();
  }

  async destroy(error?: Error): Promise<void> {
    if (this.destroyed) {
      return;
    }

    this.destroyed = true;
    const hadRunningTurn = this.session.isRunning();
    if (hadRunningTurn) {
      this.session.interrupt();
    }

    let closeError: Error | null = null;
    try {
      await this.session.destroy();
    } catch (sessionError) {
      closeError = sessionError instanceof Error
        ? sessionError
        : new Error('Failed to destroy Codex session.');
      logger.error('[CodexAgent] Failed to close session', {
        chatId: this.chatId,
        agentId: this.agentId,
        error: closeError.message,
      });
    }

    logger.info('[CodexAgent] Destroying agent', {
      chatId: this.chatId,
      agentId: this.agentId,
      hadRunningTurn,
      hasError: !!error,
      error: error?.message,
    });

    if (error && this.onErrorCallback) {
      try {
        this.onErrorCallback(error);
      } catch (callbackError) {
        logger.error('[CodexAgent] Error in onError callback', {
          agentId: this.agentId,
          error: callbackError,
        });
      }
    }

    if (closeError) {
      throw closeError;
    }
  }

  getAgentId(): string {
    return this.agentId;
  }

  getCwd(): string {
    return this.cwd;
  }

  getSessionId(): string | undefined {
    return this.session.getThreadId() ?? undefined;
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  isAlive(): boolean {
    return !this.destroyed;
  }

  isRunning(): boolean {
    return this.session.isRunning();
  }

  onResponse(callback: OnResponseCallback): void {
    this.onResponseCallback = callback;
  }

  onError(callback: OnErrorCallback): void {
    this.onErrorCallback = callback;
  }

  getStartTime(): number {
    return this.startTime;
  }

  getRuntimeStatus(): AgentRuntimeStatus {
    return this.session.getRuntimeStatus();
  }
}

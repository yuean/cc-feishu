import logger from '../utils/logger';
import type { AgentRuntimeStatus } from '../agent/runtime-status';
import type { ChatAgent, OnErrorCallback, OnResponseCallback, SendMessageOptions } from '../agent/types';
import { CLILauncher } from './launcher';
import { CLIBridge } from './bridge';

let agentCounter = 0;

export class Agent implements ChatAgent {
  private readonly agentId: string;
  private readonly chatId: string;
  private readonly cwd: string;
  private readonly launcher: CLILauncher;
  private readonly bridge: CLIBridge;
  private readonly startTime: number;
  private destroyed = false;
  private onResponseCallback: OnResponseCallback | null = null;
  private onErrorCallback: OnErrorCallback | null = null;

  constructor(chatId: string, cwd: string, resumeSessionId?: string) {
    this.agentId = `agent${++agentCounter}`;
    this.chatId = chatId;
    this.cwd = cwd;
    this.startTime = Date.now();

    logger.info('[Agent] Creating agent', {
      chatId,
      agentId: this.agentId,
      sessionId: resumeSessionId,
      cwd,
      isResume: !!resumeSessionId,
    });

    this.launcher = new CLILauncher(this.agentId);
    this.bridge = new CLIBridge(this.agentId, resumeSessionId);

    this.bridge.setOnResponse((text) => {
      logger.info('[Agent] Received response', {
        chatId: this.chatId,
        agentId: this.agentId,
        textLength: text.length,
        responseText: text,
      });
      if (this.onResponseCallback) {
        this.onResponseCallback(text);
      }
    });

    this.launcher.onExit((code) => {
      logger.info('[Agent] CLI process exited', {
        chatId: this.chatId,
        agentId: this.agentId,
        code,
        wasDestroyed: this.destroyed,
      });

      if (this.destroyed) {
        return;
      }

      const error = new Error(`CLI process exited unexpectedly with code ${code}`);
      this.destroy(error).catch(() => {});
    });

    this.launcher.start(cwd, resumeSessionId);

    const process = this.launcher.getProcess();
    if (process) {
      this.bridge.attachProcess(process);
    } else {
      const error = new Error('Failed to start CLI process');
      this.destroy(error).catch(() => {});
    }
  }

  async sendMessage(text: string, options?: SendMessageOptions): Promise<void> {
    if (this.destroyed) {
      logger.warn('[Agent] Cannot send message, agent destroyed', {
        chatId: this.chatId,
        agentId: this.agentId,
      });
      return;
    }

    logger.info('[Agent] Sending message', {
      chatId: this.chatId,
      agentId: this.agentId,
      messageLength: text.length,
      messageText: text,
    });

    try {
      await this.bridge.waitForInit();
    } catch (err) {
      await this.destroy(err as Error);
      throw err;
    }

    options?.onActivity?.();
    await this.bridge.sendUserMessage(text, options?.onComplete, () => options?.onActivity?.());
  }

  interrupt(): boolean {
    if (this.destroyed) {
      logger.warn('[Agent] Cannot interrupt, agent destroyed', {
        chatId: this.chatId,
        agentId: this.agentId,
      });
      return false;
    }

    logger.info('[Agent] Interrupting', {
      chatId: this.chatId,
      agentId: this.agentId,
    });

    return this.bridge.sendInterrupt();
  }

  async destroy(error?: Error): Promise<void> {
    if (this.destroyed) {
      return;
    }

    this.destroyed = true;

    logger.info('[Agent] Destroying agent', {
      chatId: this.chatId,
      agentId: this.agentId,
      hasError: !!error,
      error: error?.message,
    });

    if (error && this.onErrorCallback) {
      try {
        this.onErrorCallback(error);
      } catch (err) {
        logger.error('[Agent] Error in onError callback', {
          agentId: this.agentId,
          error: err,
        });
      }
    }

    this.bridge.rejectInit('Agent destroyed');
    this.bridge.detachProcess();
    await this.launcher.kill();
  }

  getAgentId(): string {
    return this.agentId;
  }

  getCwd(): string {
    return this.cwd;
  }

  getSessionId(): string | undefined {
    return this.bridge.getSessionId();
  }

  isInitialized(): boolean {
    return this.bridge.isInitialized();
  }

  isAlive(): boolean {
    return !this.destroyed && this.launcher.isAlive();
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
    return this.bridge.getRuntimeStatus();
  }

  getPid(): number | undefined {
    return this.launcher.getProcess()?.pid;
  }
}

import type { AgentRuntimeStatus } from './runtime-status';
export type OnResponseCallback = (text: string) => void;
export type OnErrorCallback = (error: Error) => void;
export type ActivityPhase =
  | 'received'
  | 'starting'
  | 'ready'
  | 'turn_starting'
  | 'turn_running'
  | 'turn_finishing'
  | 'sending_response'
  | 'cleanup';

export interface ActivityEvent {
  phase: ActivityPhase;
  reason: string;
  method?: string;
  threadId?: string | null;
  turnId?: string | null;
}

export type OnActivityCallback = (event?: ActivityEvent) => void;

export interface SendMessageOptions {
  onActivity?: OnActivityCallback;
  onComplete?: () => Promise<void>;
  imagePaths?: string[];
}

export interface ChatAgent {
  sendMessage(text: string, options?: SendMessageOptions): Promise<void>;
  interrupt(): boolean;
  destroy(error?: Error): Promise<void>;
  getAgentId(): string;
  getCwd(): string;
  getSessionId(): string | undefined;
  isInitialized(): boolean;
  isAlive(): boolean;
  isRunning?(): boolean;
  onResponse(callback: OnResponseCallback): void;
  onError(callback: OnErrorCallback): void;
  getStartTime(): number;
  getRuntimeStatus(): AgentRuntimeStatus;
}

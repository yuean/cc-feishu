export type AgentRuntimePhase =
  | 'idle'
  | 'initializing'
  | 'running'
  | 'waiting'
  | 'interrupting'
  | 'interrupted'
  | 'error';

export interface AgentRuntimeStatus {
  phase: AgentRuntimePhase;
  detail: string;
  updatedAt: number;
  lastActivityAt: number | null;
  activityCount: number;
  isTurnInProgress: boolean;
}

export function createAgentRuntimeStatus(
  overrides: Partial<AgentRuntimeStatus> = {},
): AgentRuntimeStatus {
  const now = Date.now();
  const baseStatus: AgentRuntimeStatus = {
    phase: 'idle',
    detail: '等待新任务',
    updatedAt: now,
    lastActivityAt: null,
    activityCount: 0,
    isTurnInProgress: false,
  };

  return {
    ...baseStatus,
    ...overrides,
    updatedAt: overrides.updatedAt ?? baseStatus.updatedAt,
  };
}

export function cloneAgentRuntimeStatus(status: AgentRuntimeStatus): AgentRuntimeStatus {
  return { ...status };
}

export function formatAgentRuntimePhase(phase: AgentRuntimePhase): string {
  switch (phase) {
    case 'idle':
      return '空闲';
    case 'initializing':
      return '初始化中';
    case 'running':
      return '运行中';
    case 'waiting':
      return '等待中';
    case 'interrupting':
      return '中断中';
    case 'interrupted':
      return '已中断';
    case 'error':
      return '异常';
    default:
      return phase;
  }
}

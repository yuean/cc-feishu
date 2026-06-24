import path from 'node:path';
import dotenv from 'dotenv';

loadEnvironment();

export type AgentProvider = 'claude' | 'codex';

interface Config {
  feishu: {
    appId: string;
    appSecret: string;
    allowedOpenIds: string[];
  };
  agent: {
    provider: AgentProvider;
    workRoot: string;
    idleTtlMs: number;
    sessionDayCutoffHour: number;
    longTaskNoticeFirstMs: number;
    longTaskNoticeIntervalMs: number;
    longTaskNoticeMaxCount: number;
  };
  claude: {
    model: string;
  };
  codex: {
    developerInstructions: string | null;
  };
  app: {
    env: string;
    logLevel: string;
    singleInstancePort: number;
  };
  storage: {
    chatBindingsFile: string;
  };
}

export const MODEL_MAP: Record<string, string> = {
  opus: 'claude-opus-4-6',
  sonnet: 'claude-sonnet-4-6',
};

const DEFAULT_CODEX_DEVELOPER_INSTRUCTIONS = [
  '用户通过飞书 Bot 交互，可能不在电脑前，也看不到本地终端或桌面 UI。',
  '回复时应把关键结果、文件位置、上传状态和需要用户决策的事项直接写在飞书消息里；不要依赖终端滚屏、交互式选择器、本地弹窗或“你自己去打开/复制保存”这类操作完成沟通。',
].join('\n');

function loadEnvironment(): void {
  const configuredEnvFile = (process.env.APP_ENV_FILE || '').trim();
  if (!configuredEnvFile) {
    dotenv.config();
    return;
  }

  const resolvedEnvFile = path.isAbsolute(configuredEnvFile)
    ? configuredEnvFile
    : path.resolve(process.cwd(), configuredEnvFile);
  const result = dotenv.config({
    path: resolvedEnvFile,
    override: true,
  });

  if (result.error) {
    throw result.error;
  }
}

function resolveAgentProvider(): AgentProvider {
  const rawValue = (process.env.AGENT_PROVIDER || 'codex').trim().toLowerCase();
  if (rawValue === 'claude' || rawValue === 'codex') {
    return rawValue;
  }

  throw new Error(`Unsupported AGENT_PROVIDER: ${process.env.AGENT_PROVIDER}`);
}

function parsePositiveInt(name: string, fallback: number): number {
  const rawValue = (process.env[name] || `${fallback}`).trim();
  const parsed = Number.parseInt(rawValue, 10);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${name}: ${rawValue}`);
  }

  return parsed;
}

function parsePort(name: string, fallback: number): number {
  const parsed = parsePositiveInt(name, fallback);
  if (parsed > 65535) {
    throw new Error(`Invalid ${name}: ${parsed}`);
  }
  return parsed;
}

function parseHour(name: string, fallback: number): number {
  const rawValue = (process.env[name] || `${fallback}`).trim();
  const parsed = Number.parseInt(rawValue, 10);

  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 23) {
    throw new Error(`Invalid ${name}: ${rawValue}`);
  }

  return parsed;
}

function parseCsvList(rawValue: string | undefined): string[] {
  return (rawValue || '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

function parseAllowedOpenIds(): string[] {
  return parseCsvList(process.env.FEISHU_ALLOWED_OPEN_IDS);
}

function resolveAgentWorkRoot(): string {
  const preferred = (process.env.AGENT_WORK_ROOT || '').trim();
  if (preferred) {
    return preferred;
  }

  const legacy = (process.env.CLAUDE_WORK_ROOT || '').trim();
  if (legacy) {
    return legacy;
  }

  return process.cwd();
}

function resolveStoragePath(rawValue: string | undefined, fallbackRelativePath: string): string {
  const normalized = (rawValue || '').trim();
  if (!normalized) {
    return path.resolve(process.cwd(), fallbackRelativePath);
  }

  return path.isAbsolute(normalized)
    ? normalized
    : path.resolve(process.cwd(), normalized);
}

function resolveCodexDeveloperInstructions(): string | null {
  if (process.env.CODEX_DEVELOPER_INSTRUCTIONS !== undefined) {
    const configuredInstructions = process.env.CODEX_DEVELOPER_INSTRUCTIONS.trim();
    return configuredInstructions || null;
  }

  return DEFAULT_CODEX_DEVELOPER_INSTRUCTIONS;
}

const config: Config = {
  feishu: {
    appId: process.env.FEISHU_APP_ID || '',
    appSecret: process.env.FEISHU_APP_SECRET || '',
    allowedOpenIds: parseAllowedOpenIds(),
  },
  agent: {
    provider: resolveAgentProvider(),
    workRoot: resolveAgentWorkRoot(),
    idleTtlMs: parsePositiveInt('AGENT_IDLE_TTL_MS', 4 * 60 * 60 * 1000),
    sessionDayCutoffHour: parseHour('AGENT_SESSION_DAY_CUTOFF_HOUR', 5),
    longTaskNoticeFirstMs: parsePositiveInt('AGENT_LONG_TASK_NOTICE_FIRST_MS', 60 * 1000),
    longTaskNoticeIntervalMs: parsePositiveInt('AGENT_LONG_TASK_NOTICE_INTERVAL_MS', 3 * 60 * 1000),
    longTaskNoticeMaxCount: parsePositiveInt('AGENT_LONG_TASK_NOTICE_MAX_COUNT', 5),
  },
  claude: {
    model: process.env.CLAUDE_MODEL || 'claude-opus-4-6',
  },
  codex: {
    developerInstructions: resolveCodexDeveloperInstructions(),
  },
  app: {
    env: process.env.NODE_ENV || 'development',
    logLevel: process.env.LOG_LEVEL || 'info',
    singleInstancePort: parsePort('SINGLE_INSTANCE_PORT', 8652),
  },
  storage: {
    chatBindingsFile: resolveStoragePath(process.env.CHAT_BINDINGS_FILE, path.join('data', 'chat-bindings.json')),
  },
};

if (!config.feishu.appId || !config.feishu.appSecret) {
  throw new Error('Missing required Feishu credentials: FEISHU_APP_ID and FEISHU_APP_SECRET');
}

export default config;

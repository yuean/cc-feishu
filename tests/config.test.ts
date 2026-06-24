import assert from 'assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

type ConfigModule = typeof import('../src/config');

const sandboxRoot = mkdtempSync(path.join(tmpdir(), 'cc-feishu-config-'));
const originalCwd = process.cwd();

function loadConfig(): ConfigModule['default'] {
  const modulePath = require.resolve('../src/config');
  delete require.cache[modulePath];
  return (require('../src/config') as ConfigModule).default;
}

function withEnv(env: Record<string, string | undefined>, run: () => void): void {
  const previousValues = new Map<string, string | undefined>();

  for (const [key, value] of Object.entries(env)) {
    previousValues.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    run();
  } finally {
    for (const [key, value] of previousValues.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

async function main(): Promise<void> {
  try {
    withEnv({
      FEISHU_APP_ID: 'test-app-id',
      FEISHU_APP_SECRET: 'test-app-secret',
      FEISHU_ALLOWED_OPEN_IDS: 'ou_admin',
    }, () => {
      withEnv({
        AGENT_WORK_ROOT: 'C:\\work\\preferred-root',
        CLAUDE_WORK_ROOT: 'C:\\work\\legacy-root',
        CHAT_BINDINGS_FILE: undefined,
        AGENT_IDLE_TTL_MS: undefined,
        AGENT_SESSION_DAY_CUTOFF_HOUR: undefined,
        AGENT_LONG_TASK_NOTICE_FIRST_MS: undefined,
        AGENT_LONG_TASK_NOTICE_INTERVAL_MS: undefined,
        AGENT_LONG_TASK_NOTICE_MAX_COUNT: undefined,
      }, () => {
        const config = loadConfig();
        assert.equal((config as any).agent.workRoot, 'C:\\work\\preferred-root');
        assert.equal((config as any).agent.idleTtlMs, 4 * 60 * 60 * 1000);
        assert.equal((config as any).agent.sessionDayCutoffHour, 5);
        assert.equal((config as any).agent.longTaskNoticeFirstMs, 60 * 1000);
        assert.equal((config as any).agent.longTaskNoticeIntervalMs, 3 * 60 * 1000);
        assert.equal((config as any).agent.longTaskNoticeMaxCount, 5);
        assert.match((config as any).codex.developerInstructions, /飞书 Bot/);
      });

      withEnv({
        AGENT_WORK_ROOT: '',
        CLAUDE_WORK_ROOT: 'C:\\work\\legacy-root',
        CHAT_BINDINGS_FILE: undefined,
      }, () => {
        const config = loadConfig();
        assert.equal((config as any).agent.workRoot, 'C:\\work\\legacy-root');
      });

      withEnv({
        AGENT_IDLE_TTL_MS: '60000',
        AGENT_SESSION_DAY_CUTOFF_HOUR: '4',
      }, () => {
        const config = loadConfig();
        assert.equal((config as any).agent.idleTtlMs, 60_000);
        assert.equal((config as any).agent.sessionDayCutoffHour, 4);
      });

      withEnv({
        CODEX_DEVELOPER_INSTRUCTIONS: ' custom codex instructions ',
      }, () => {
        const config = loadConfig();
        assert.equal((config as any).codex.developerInstructions, 'custom codex instructions');
      });

      withEnv({
        CODEX_DEVELOPER_INSTRUCTIONS: '   ',
      }, () => {
        const config = loadConfig();
        assert.equal((config as any).codex.developerInstructions, null);
      });

      process.chdir(sandboxRoot);
      withEnv({
        AGENT_WORK_ROOT: '',
        CLAUDE_WORK_ROOT: '',
        CHAT_BINDINGS_FILE: 'data/chat-bindings.json',
      }, () => {
        const config = loadConfig();
        assert.equal((config as any).agent.workRoot, sandboxRoot);
        assert.equal(
          config.storage.chatBindingsFile,
          path.resolve(sandboxRoot, 'data/chat-bindings.json'),
        );
      });

      const appEnvFile = path.join(sandboxRoot, '.env.testbot');
      const defaultEnvFile = path.join(sandboxRoot, '.env');
      writeFileSync(appEnvFile, [
        'FEISHU_APP_ID=testbot-app-id',
        'FEISHU_APP_SECRET=testbot-app-secret',
        'AGENT_WORK_ROOT=C:\\work\\testbot-root',
      ].join('\n'), 'utf8');
      writeFileSync(defaultEnvFile, [
        'FEISHU_APP_ID=default-app-id',
        'FEISHU_APP_SECRET=default-app-secret',
        'AGENT_WORK_ROOT=C:\\work\\default-root',
      ].join('\n'), 'utf8');

      process.chdir(sandboxRoot);
      withEnv({
        APP_ENV_FILE: '.env.testbot',
        FEISHU_APP_ID: 'shell-app-id',
        FEISHU_APP_SECRET: 'shell-app-secret',
        AGENT_WORK_ROOT: 'C:\\work\\shell-root',
      }, () => {
        const config = loadConfig();
        assert.equal(config.feishu.appId, 'testbot-app-id');
        assert.equal(config.feishu.appSecret, 'testbot-app-secret');
        assert.equal((config as any).agent.workRoot, 'C:\\work\\testbot-root');
      });
    });

    console.log('config.test.ts passed');
  } finally {
    process.chdir(originalCwd);
    rmSync(sandboxRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

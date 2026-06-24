import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

process.env.FEISHU_APP_ID = process.env.FEISHU_APP_ID || 'test-app-id';
process.env.FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET || 'test-app-secret';

import type { CreateAgentOptions } from '../src/agent/factory';
import { createAgentRuntimeStatus } from '../src/agent/runtime-status';

function writeSession(
  sessionsDir: string,
  datePath: string,
  cwd: string,
  sessionId: string,
  firstMessage: string,
  mtimeMs: number,
): void {
  const targetDir = join(sessionsDir, datePath);
  mkdirSync(targetDir, { recursive: true });

  const filePath = join(targetDir, `rollout-${sessionId}.jsonl`);
  const lines = [
    JSON.stringify({
      timestamp: new Date(mtimeMs).toISOString(),
      type: 'session_meta',
      payload: {
        id: sessionId,
        cwd,
      },
    }),
    JSON.stringify({
      timestamp: new Date(mtimeMs + 1).toISOString(),
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: firstMessage,
          },
        ],
      },
    }),
  ];

  writeFileSync(filePath, `${lines.join('\n')}\n`);
  const timestamp = new Date(mtimeMs);
  utimesSync(filePath, timestamp, timestamp);
}

function createFakeAgent() {
  return {
    sendMessage: async () => undefined,
    interrupt: () => false,
    destroy: async () => undefined,
    getAgentId: () => 'fake-agent',
    getCwd: () => 'C:\\work\\repo-alpha',
    getSessionId: () => undefined,
    isInitialized: () => false,
    isAlive: () => true,
    onResponse: () => undefined,
    onError: () => undefined,
    getStartTime: () => Date.now(),
    getRuntimeStatus: () => createAgentRuntimeStatus({
      phase: 'idle',
      detail: 'synthetic idle',
      lastActivityAt: Date.now(),
    }),
  };
}

const sandboxRoot = mkdtempSync(join(tmpdir(), 'cc-feishu-codex-resume-'));
const sessionsDir = join(sandboxRoot, '.codex', 'sessions');
const os = require('os') as typeof import('os') & { homedir: () => string };
const originalHomedir = os.homedir;
os.homedir = () => sandboxRoot;

const {
  ChatManager,
} = require('../src/bot/chat-manager') as typeof import('../src/bot/chat-manager');

async function main(): Promise<void> {
  try {
    writeSession(
      sessionsDir,
      join('2026', '04', '30'),
      'C:\\work\\repo-alpha',
      'codex-resume-id',
      'resume this codex session',
      Date.now() - 10_000,
    );

    {
      const manager = new ChatManager({
        defaultCwd: 'C:\\work\\repo-alpha',
        defaultProvider: 'codex',
        agentFactory: () => createFakeAgent() as any,
      });

      const sessions = manager.getRecentSessions('oc_codex');
      assert.equal(manager.supportsSessionResume('oc_codex'), true);
      assert.match(manager.listSessions('oc_codex'), /Sessions/);
      assert.equal(manager.getSessionCount('oc_codex'), 1);
      assert.equal(sessions.length, 1);
      assert.equal(sessions[0].sessionId, 'codex-resume-id');
      assert.equal(sessions[0].cwd, 'C:\\work\\repo-alpha');
      assert.equal(sessions[0].filePath, join(sessionsDir, '2026', '04', '30', 'rollout-codex-resume-id.jsonl'));
      assert.equal(sessions[0].firstMessage, 'resume this codex session');
      assert.ok(Number.isFinite(sessions[0].mtimeMs));
    }

    {
      const capturedOptions: CreateAgentOptions[] = [];
      const manager = new ChatManager({
        defaultCwd: 'C:\\work',
        defaultProvider: 'codex',
        sessionDecisionNotifier: async () => undefined,
        agentFactory: (options) => {
          capturedOptions.push(options);
          return createFakeAgent() as any;
        },
      });

      (manager as any).chats.set('oc_codex', {
        cwd: 'C:\\work\\repo-alpha',
        provider: 'codex',
        sessionId: 'codex-resume-id',
        sessionNotified: false,
      });

      await manager.sendMessage('oc_codex', 'hello codex');
      assert.equal(capturedOptions.length, 1);
      assert.equal(capturedOptions[0].provider, 'codex');
      assert.equal(capturedOptions[0].resumeSessionId, 'codex-resume-id');
    }

    {
      const capturedOptions: CreateAgentOptions[] = [];
      const manager = new ChatManager({
        defaultCwd: 'C:\\work',
        defaultProvider: 'claude',
        sessionDecisionNotifier: async () => undefined,
        agentFactory: (options) => {
          capturedOptions.push(options);
          return createFakeAgent() as any;
        },
      });

      (manager as any).chats.set('oc_claude', {
        cwd: 'C:\\work\\repo-beta',
        provider: 'claude',
        sessionId: 'claude-resume-id',
        sessionNotified: false,
      });

      await manager.sendMessage('oc_claude', 'hello claude');
      assert.equal(capturedOptions.length, 1);
      assert.equal(capturedOptions[0].provider, 'claude');
      assert.equal(capturedOptions[0].resumeSessionId, 'claude-resume-id');
    }

    console.log('codex-resume-enabled.test.ts passed');
  } finally {
    os.homedir = originalHomedir;
    rmSync(sandboxRoot, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

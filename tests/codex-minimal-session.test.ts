import assert from 'node:assert/strict';

process.env.FEISHU_APP_ID = process.env.FEISHU_APP_ID || 'test-app-id';
process.env.FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET || 'test-app-secret';

const {
  CodexMinimalSession,
  TurnAbortedError,
} = require('../src/codex-minimal/session') as typeof import('../src/codex-minimal/session');

async function captureError<T>(promise: Promise<T>): Promise<unknown> {
  try {
    await promise;
    return null;
  } catch (error) {
    return error;
  }
}

async function main() {
  {
    const session = new CodexMinimalSession({
      workingDirectory: 'C:\\work\\cc-feishu',
    });
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];

    (session as any).threadId = 'thread-1';
    (session as any).activeTurnId = 'turn-1';
    (session as any).activeTurn = {
      interruptRequested: false,
    };
    (session as any).rpcClient = {
      request(method: string, params: Record<string, unknown>): Promise<Record<string, never>> {
        requests.push({ method, params });
        return Promise.resolve({});
      },
    };

    assert.equal(session.interrupt(), true);
    await Promise.resolve();
    assert.equal((session as any).activeTurn.interruptRequested, true);
    assert.deepEqual(requests, [
      {
        method: 'turn/interrupt',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
        },
      },
    ]);
  }

  {
    const session = new CodexMinimalSession({
      workingDirectory: 'C:\\work\\cc-feishu',
    });
    const activeTurn = (session as any).createActiveTurn(undefined);

    activeTurn.turnId = 'turn-1';
    activeTurn.interruptRequested = true;
    (session as any).threadId = 'thread-1';
    (session as any).activeTurn = activeTurn;
    (session as any).rpcClient = {
      getTurnError(): null {
        return null;
      },
    };

    (session as any).handleAppServerLine(JSON.stringify({
      jsonrpc: '2.0',
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: {
          id: 'turn-1',
          status: 'interrupted',
        },
      },
    }));

    const abortError = await captureError(activeTurn.promise);
    assert.ok(abortError instanceof TurnAbortedError);
  }

  {
    const session = new CodexMinimalSession({
      workingDirectory: 'C:\\work\\cc-feishu',
    });
    const activeTurn = (session as any).createActiveTurn(undefined);

    activeTurn.turnId = 'turn-2';
    activeTurn.interruptRequested = true;
    (session as any).threadId = 'thread-1';
    (session as any).activeTurn = activeTurn;
    (session as any).rpcClient = {
      getTurnError(): null {
        return null;
      },
    };

    (session as any).handleAppServerLine(JSON.stringify({
      jsonrpc: '2.0',
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: {
          id: 'turn-2',
          status: 'failed',
          error: {
            message: 'real failure',
          },
        },
      },
    }));

    const failureError = await captureError(activeTurn.promise);
    assert.ok(failureError instanceof Error);
    assert.equal((failureError as Error).message, 'real failure');
    assert.equal(failureError instanceof TurnAbortedError, false);
  }

  {
    const session = new CodexMinimalSession({
      workingDirectory: 'C:\\work\\cc-feishu',
    });
    const activeTurn = (session as any).createActiveTurn(undefined);

    (session as any).threadId = 'thread-1';
    (session as any).activeTurn = activeTurn;
    (session as any).rpcClient = {
      getTurnError(): null {
        return null;
      },
    };

    (session as any).handleAppServerLine(JSON.stringify({
      jsonrpc: '2.0',
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        item: {
          type: 'agentMessage',
          id: 'item-1',
          text: 'phase omitted response',
        },
      },
    }));
    (session as any).handleAppServerLine(JSON.stringify({
      jsonrpc: '2.0',
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: {
          id: 'turn-3',
          status: 'completed',
        },
      },
    }));

    const result = await activeTurn.promise;
    assert.equal(result.text, 'phase omitted response');
  }

  {
    const session = new CodexMinimalSession({
      workingDirectory: 'C:\\work\\cc-feishu',
    });
    let turnStartRequested = false;

    (session as any).threadId = 'thread-1';
    (session as any).state = 'ready';
    (session as any).rpcClient = {
      request(method: string, params: Record<string, unknown>): Promise<Record<string, never>> {
        assert.equal(method, 'turn/start');
        turnStartRequested = true;
        assert.deepEqual(params.input, [
          { type: 'text', text: 'describe this image', text_elements: [] },
          { type: 'localImage', path: 'C:\\tmp\\image.png' },
        ]);
        return Promise.resolve({});
      },
      getTurnError(): null {
        return null;
      },
    };

    const runPromise = (session as any).runTurn('describe this image', {
      imagePaths: ['C:\\tmp\\image.png'],
    });
    await Promise.resolve();
    assert.equal(turnStartRequested, true);
    (session as any).handleAppServerLine(JSON.stringify({
      jsonrpc: '2.0',
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: {
          id: 'turn-4',
          status: 'completed',
        },
      },
    }));

    await runPromise;
  }

  {
    const session = new CodexMinimalSession({
      workingDirectory: 'C:\\work\\cc-feishu',
    });
    const activities: Array<{ phase?: string; reason?: string; method?: string; turnId?: string | null }> = [];
    const activeTurn = (session as any).createActiveTurn((event: any) => {
      activities.push(event);
    });

    (session as any).threadId = 'thread-1';
    (session as any).activeTurn = activeTurn;
    (session as any).rpcClient = {
      getTurnId(): string {
        return 'turn-activity';
      },
      getTurnError(): null {
        return null;
      },
    };

    (session as any).handleAppServerLine(JSON.stringify({
      jsonrpc: '2.0',
      method: 'turn/started',
      params: {
        threadId: 'thread-1',
        turn: {
          id: 'turn-activity',
        },
      },
    }));
    (session as any).handleAppServerLine(JSON.stringify({
      jsonrpc: '2.0',
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        item: {
          type: 'agentMessage',
          text: 'activity response',
        },
      },
    }));

    assert.deepEqual(activities.map(activity => ({
      phase: activity.phase,
      reason: activity.reason,
      method: activity.method,
      turnId: activity.turnId,
    })), [
      {
        phase: 'turn_running',
        reason: 'turn started',
        method: 'turn/started',
        turnId: 'turn-activity',
      },
      {
        phase: 'turn_running',
        reason: 'Codex 已开始处理当前轮次',
        method: undefined,
        turnId: 'turn-activity',
      },
      {
        phase: 'turn_running',
        reason: 'item completed (agentMessage)',
        method: 'item/completed',
        turnId: 'turn-activity',
      },
      {
        phase: 'turn_running',
        reason: 'Codex 回复内容已更新',
        method: undefined,
        turnId: 'turn-activity',
      },
    ]);
  }

  console.log('codex-minimal-session.test.ts passed');
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

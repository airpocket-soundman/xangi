import { EventEmitter } from 'node:events';
import type { Server as HttpServer } from 'node:http';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
vi.mock('../src/setup/backend-executable.js', () => ({ configuredBackendCommand: () => 'codex' }));
import { spawn } from 'node:child_process';
import { CodexRunner } from '../src/codex-cli.js';
import { startLineBot } from '../src/line.js';

/** initialize → thread/start → turn/start に最小限だけ応答する app-server の代役 */
class AppServer extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  pid = undefined;
  kill = vi.fn();
  constructor() {
    super();
    this.stdin.on('data', (chunk) => {
      const { method, id } = JSON.parse(chunk.toString());
      if (method === 'initialize') this.send({ id, result: {} });
      if (method === 'thread/start' || method === 'thread/resume')
        this.send({
          id,
          result: { thread: { id: 'thread-a' }, sandbox: { type: 'workspaceWrite' } },
        });
      if (method === 'turn/start') {
        this.send({ id, result: { turn: { id: 'turn-1' } } });
        this.send({
          method: 'item/completed',
          params: {
            threadId: 'thread-a',
            turnId: 'turn-1',
            item: { type: 'agentMessage', phase: 'final_answer', text: 'hello' },
          },
        });
        this.send({
          method: 'turn/completed',
          params: { threadId: 'thread-a', turn: { id: 'turn-1', status: 'completed' } },
        });
      }
    });
  }
  send(x: unknown) {
    this.stdout.write(JSON.stringify(x) + '\n');
  }
}

const savedToolServer = process.env.XANGI_TOOL_SERVER;
let runner: CodexRunner;
let lineServer: HttpServer | undefined;

beforeEach(() => {
  vi.mocked(spawn).mockReset();
  vi.mocked(spawn).mockImplementation(() => new AppServer() as never);
  delete process.env.XANGI_TOOL_SERVER;
  runner = new CodexRunner({ platform: 'line', workdir: '/tmp', timeoutMs: 1000 });
});

afterEach(async () => {
  runner.shutdown();
  if (lineServer) await new Promise<void>((resolve) => lineServer!.close(() => resolve()));
  lineServer = undefined;
  if (savedToolServer === undefined) delete process.env.XANGI_TOOL_SERVER;
  else process.env.XANGI_TOOL_SERVER = savedToolServer;
});

describe('LINE app-server と tool-server の接続先', () => {
  it('ツールサーバーより先にLINEを起動しても最初の発言で起動するプロセスには接続先が渡る', async () => {
    lineServer = await startLineBot({
      agentRunner: runner,
      resolver: {} as never,
      channelSecret: 'secret',
      channelAccessToken: 'token',
      allowedUsers: ['Utest-user'],
      port: 0,
      codexTransport: 'app-server',
    });

    // tool-server が待ち受けを始めた時点で入る値
    process.env.XANGI_TOOL_SERVER = 'http://127.0.0.1:46731';

    // LINE の発言処理（src/line.ts）が渡すのと同じ指定で 1 件処理させる
    await runner.run('hello', {
      channelId: 'line:Utest-user',
      codexLineTransport: 'app-server',
    });

    const firstSpawnEnv = vi.mocked(spawn).mock.calls[0][2]?.env;
    expect(firstSpawnEnv?.XANGI_TOOL_SERVER).toBe('http://127.0.0.1:46731');
  });
});

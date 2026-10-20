import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createServer, type Server } from 'http';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  );
});

const options = {
  agentRunner: {} as never,
  resolver: {} as never,
  channelSecret: 'secret',
  channelAccessToken: 'token',
  allowedUsers: ['*'],
};

describe('LINE webhook startup', () => {
  it('resolves only after listening', async () => {
    const server = await startLineBot({ ...options, port: 0 });
    servers.push(server);
    const address = server.address();
    expect(typeof address === 'object' && address?.port).toBeGreaterThan(0);
  });

  it('rejects a port conflict without an uncaught server error', async () => {
    const blocker = createServer();
    servers.push(blocker);
    await new Promise<void>((resolve) => blocker.listen(0, resolve));
    const address = blocker.address();
    if (!address || typeof address === 'string') throw new Error('missing test port');

    await expect(startLineBot({ ...options, port: address.port })).rejects.toMatchObject({
      code: 'EADDRINUSE',
    });
  });
  it('ツールサーバーより先にLINEを起動しても最初の発言で起動するプロセスには接続先が渡る', async () => {
    const savedToolServer = process.env.XANGI_TOOL_SERVER;
    vi.mocked(spawn).mockReset();
    vi.mocked(spawn).mockImplementation(() => new AppServer() as never);
    delete process.env.XANGI_TOOL_SERVER;
    const runner = new CodexRunner({ platform: 'line', workdir: '/tmp', timeoutMs: 1000 });
    try {
      const server = await startLineBot({
        ...options,
        agentRunner: runner,
        allowedUsers: ['Utest-user'],
        port: 0,
        codexTransport: 'app-server',
      });
      servers.push(server);

      // tool-server が待ち受けを始めた時点で入る値
      process.env.XANGI_TOOL_SERVER = 'http://127.0.0.1:46731';

      // LINE の発言処理（src/line.ts）が渡すのと同じ指定で 1 件処理させる
      await runner.run('hello', {
        channelId: 'line:Utest-user',
        codexLineTransport: 'app-server',
      });

      const firstSpawnEnv = vi.mocked(spawn).mock.calls[0][2]?.env;
      expect(firstSpawnEnv?.XANGI_TOOL_SERVER).toBe('http://127.0.0.1:46731');
    } finally {
      runner.shutdown();
      if (savedToolServer === undefined) delete process.env.XANGI_TOOL_SERVER;
      else process.env.XANGI_TOOL_SERVER = savedToolServer;
    }
  });
});

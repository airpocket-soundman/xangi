import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunResult, StreamCallbacks } from '../src/agent-runner.js';
import { LocalLlmRunner } from '../src/local-llm/runner.js';

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'local-retry-attachments-'));
  vi.stubEnv('LOCAL_LLM_MODE', 'agent');
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(workspace, { recursive: true, force: true });
});

function setup(chat: ReturnType<typeof vi.fn>) {
  const runner = new LocalLlmRunner({ workdir: workspace, model: 'test' });
  Object.assign(runner, { llm: { chat, chatStream: vi.fn() } });
  return runner;
}

function sendFile(path: string) {
  return {
    content: '',
    finishReason: 'tool_calls',
    toolCalls: [{ id: `send-${path}`, name: 'send_file', arguments: { path } }],
  };
}

function complete(content = '送りました') {
  return { content, finishReason: 'stop', toolCalls: [] };
}

async function runTurn(
  runner: LocalLlmRunner,
  method: 'run' | 'runStream',
  prompt: string,
  channelId: string,
  callbacks: StreamCallbacks = {}
): Promise<RunResult> {
  const options = { channelId, sessionId: channelId };
  return method === 'run'
    ? runner.run(prompt, options)
    : runner.runStream(prompt, callbacks, options);
}

describe('local LLM retry attachments', () => {
  it.each(['run', 'runStream'] as const)(
    '%s returns retry attachments and exposes them to onComplete',
    async (method) => {
      const japanese = join(workspace, 'レポート（最終版）、確認.pdf');
      const spaced = join(workspace, 'my report (v2).pdf');
      writeFileSync(japanese, 'japanese report');
      writeFileSync(spaced, 'spaced report');
      const chat = vi
        .fn()
        .mockResolvedValueOnce(complete('ready'))
        .mockRejectedValueOnce(new Error('400 Bad Request'))
        .mockResolvedValueOnce(sendFile(japanese))
        .mockResolvedValueOnce(sendFile(spaced))
        .mockResolvedValueOnce(complete());
      const runner = setup(chat);
      const channelId = `retry-${method}`;
      await runner.run('warm up', { channelId, sessionId: channelId });
      const onComplete = vi.fn();

      const result = await runTurn(runner, method, 'send reports', channelId, { onComplete });
      const expected = [realpathSync(japanese), realpathSync(spaced)];

      expect(result.attachments).toEqual(expected);
      if (method === 'runStream') expect(onComplete).toHaveBeenCalledWith(result);
    }
  );

  it.each(['run', 'runStream'] as const)(
    '%s keeps files queued before a retry and de-duplicates repeated paths',
    async (method) => {
      const beforeRetry = join(workspace, 'before-retry.pdf');
      const duringRetry = join(workspace, 'during retry.pdf');
      writeFileSync(beforeRetry, 'before');
      writeFileSync(duringRetry, 'during');
      const chat = vi
        .fn()
        .mockResolvedValueOnce(complete('ready'))
        .mockResolvedValueOnce(sendFile(beforeRetry))
        .mockRejectedValueOnce(new Error('400 Bad Request'))
        .mockResolvedValueOnce(sendFile(beforeRetry))
        .mockResolvedValueOnce(sendFile(duringRetry))
        .mockResolvedValueOnce(complete());
      const runner = setup(chat);
      const channelId = `leftover-${method}`;
      await runner.run('warm up', { channelId, sessionId: channelId });

      const result = await runTurn(runner, method, 'send files', channelId);

      expect(result.attachments).toEqual([realpathSync(beforeRetry), realpathSync(duringRetry)]);
    }
  );

  it.each(['run', 'runStream'] as const)(
    '%s omits attachments when both attempts fail',
    async (method) => {
      const partial = join(workspace, 'partial.pdf');
      writeFileSync(partial, 'partial');
      const chat = vi
        .fn()
        .mockResolvedValueOnce(complete('ready'))
        .mockResolvedValueOnce(sendFile(partial))
        .mockRejectedValueOnce(new Error('400 Bad Request'))
        .mockRejectedValueOnce(new Error('400 Bad Request'));
      const runner = setup(chat);
      const channelId = `failure-${method}`;
      await runner.run('warm up', { channelId, sessionId: channelId });

      const result = await runTurn(runner, method, 'fail', channelId);

      expect(result.failed).toBe(true);
      expect(result.attachments).toBeUndefined();
    }
  );

  it.each(['run', 'runStream'] as const)(
    '%s returns attachments normally and resets them for the next turn',
    async (method) => {
      const file = join(workspace, 'normal attachment.pdf');
      writeFileSync(file, 'normal');
      const chat = vi
        .fn()
        .mockResolvedValueOnce(sendFile(file))
        .mockResolvedValueOnce(complete())
        .mockResolvedValueOnce(complete('clean turn'));
      const runner = setup(chat);
      const channelId = `normal-${method}`;

      const attached = await runTurn(runner, method, 'send file', channelId);
      const clean = await runTurn(runner, method, 'no file', channelId);

      expect(attached.attachments).toEqual([realpathSync(file)]);
      expect(clean.attachments ?? []).toEqual([]);
    }
  );
});

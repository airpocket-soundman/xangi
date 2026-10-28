import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodexRunner } from '../src/codex-cli.js';
import { ClaudeCodeRunner } from '../src/claude-code.js';
import type { RunResult } from '../src/agent-runner.js';

// Only the process boundary is fake; both real adapters and the shared runner execute.
const { processes, spawn } = vi.hoisted(() => ({
  processes: [] as MockProcess[],
  spawn: vi.fn(),
}));
vi.mock('child_process', () => ({ spawn }));
vi.mock('../src/transcript-logger.js', () => ({ logPrompt: vi.fn(), logResponse: vi.fn() }));
vi.mock('fs', async () => ({
  ...(await vi.importActual('fs')),
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => ''),
}));

class MockProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = { write: vi.fn(), end: vi.fn() };
  killed = false;
  exitCode: number | null = null;
  signalCode: string | null = null;
  // Deliberately do not emit close here: real processes close asynchronously.
  kill = vi.fn(() => {
    this.killed = true;
    return true;
  });
  close(code: number | null = 0) {
    this.exitCode = code;
    this.signalCode = code === null ? 'SIGTERM' : null;
    this.emit('close', code, this.signalCode);
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  processes.length = 0;
  spawn.mockImplementation(() => {
    const process = new MockProcess();
    processes.push(process);
    return process;
  });
});
afterEach(() => {
  for (const process of processes) {
    if (process.exitCode === null && process.signalCode === null) process.close(1);
  }
});

const adapters = [
  {
    name: 'Codex',
    create: () => new CodexRunner({ timeoutMs: 5000 }),
    events: (text: string) => [
      { type: 'thread.started', thread_id: 'session-1' },
      { type: 'item.completed', item: { type: 'agent_message', text } },
      { type: 'turn.completed' },
    ],
  },
  {
    name: 'Claude',
    create: () => new ClaudeCodeRunner({ timeoutMs: 5000 }),
    events: (text: string) => [
      { type: 'assistant', message: { content: [{ type: 'text', text }] } },
      { type: 'result', result: text, session_id: 'session-1', is_error: false },
    ],
  },
];

// Attach rejection handling immediately, including tests that inspect a still-open process.
function observe(promise: Promise<RunResult>) {
  return promise.then(
    (value) => ({ status: 'fulfilled' as const, value }),
    (error) => ({ status: 'rejected' as const, error })
  );
}

describe.each(adapters)('$name lifecycle without a CLI', ({ name, create, events }) => {
  function output(process: MockProcess, text: string, stream = true) {
    const payload = events(text);
    const selected = name === 'Claude' && !stream ? payload.slice(-1) : payload;
    process.stdout.emit('data', selected.map((event) => JSON.stringify(event)).join('\n') + '\n');
  }

  it('streams, completes once, and passes the returned session into the next turn', async () => {
    const runner = create();
    const onText = vi.fn(),
      onComplete = vi.fn(),
      onError = vi.fn();
    const first = runner.runStream(
      'first',
      { onText, onComplete, onError },
      { channelId: 'first' }
    );
    await vi.waitFor(() => expect(processes).toHaveLength(1));
    output(processes[0], 'hello');
    expect(onText).toHaveBeenCalledWith('hello', 'hello');
    expect(onComplete).not.toHaveBeenCalled();
    processes[0].close();
    const result = await first;
    expect(result).toMatchObject({ result: 'hello', sessionId: 'session-1' });
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
    const second = runner.runStream(
      'second',
      {},
      { channelId: 'first', sessionId: result.sessionId }
    );
    await vi.waitFor(() => expect(processes).toHaveLength(2));
    const args = spawn.mock.calls[1][1] as string[];
    const resume = args.indexOf(name === 'Codex' ? 'resume' : '--resume');
    expect(resume).toBeGreaterThanOrEqual(0);
    expect(args[resume + 1]).toBe(result.sessionId);
    output(processes[1], 'world');
    processes[1].close();
    await expect(second).resolves.toMatchObject({ result: 'world' });
  });

  it.each(['run', 'runStream'] as const)(
    '%s rejects cancellation even if late output exits zero',
    async (method) => {
      const runner = create();
      const onText = vi.fn(),
        onComplete = vi.fn(),
        onError = vi.fn();
      const result = observe(
        method === 'run'
          ? runner.run('cancel me', { channelId: 'cancel' })
          : runner.runStream('cancel me', { onText, onComplete, onError }, { channelId: 'cancel' })
      );
      await vi.waitFor(() => expect(processes).toHaveLength(1));
      expect(runner.cancel('cancel')).toBe(true);
      expect(processes[0].kill).toHaveBeenCalledTimes(1);
      output(processes[0], 'late success', method === 'runStream');
      processes[0].close(0);
      expect(await result).toMatchObject({
        status: 'rejected',
        error: expect.objectContaining({ message: expect.stringMatching(/cancel/i) }),
      });
      expect(onText).not.toHaveBeenCalled();
      expect(onComplete).not.toHaveBeenCalled();
      if (method === 'runStream') expect(onError).toHaveBeenCalledTimes(1);
      expect(runner.hasRunner('cancel')).toBe(false);
      expect(runner.getTimeoutState('cancel').active).toBe(false);
    }
  );

  it('settles cancellation before delayed close and leaves another channel running', async () => {
    const runner = create();
    const cancelled = observe(runner.runStream('cancel', {}, { channelId: 'a' }));
    const other = observe(runner.runStream('keep going', {}, { channelId: 'b' }));
    await vi.waitFor(() => expect(processes).toHaveLength(2));
    let settled = false;
    void cancelled.then(() => {
      settled = true;
    });
    expect(runner.cancel('a')).toBe(true);
    await vi.waitFor(() => expect(settled).toBe(true));
    expect(processes[1].kill).not.toHaveBeenCalled();
    processes[0].close(null);
    expect(runner.hasRunner('b')).toBe(true);
    expect(runner.getTimeoutState('b').active).toBe(true);
    output(processes[1], 'other');
    processes[1].close();
    expect(await other).toMatchObject({ status: 'fulfilled', value: { result: 'other' } });
    expect(await cancelled).toMatchObject({ status: 'rejected' });
    const next = runner.runStream('next', {}, { channelId: 'a' });
    await vi.waitFor(() => expect(processes).toHaveLength(3));
    output(processes[2], 'next');
    processes[2].close();
    await expect(next).resolves.toMatchObject({ result: 'next' });
  });

  it('marks cancellation before a synchronous close and never emits completion', async () => {
    const runner = create();
    const onComplete = vi.fn(),
      onError = vi.fn();
    const result = observe(
      runner.runStream('cancel', { onComplete, onError }, { channelId: 'sync' })
    );
    await vi.waitFor(() => expect(processes).toHaveLength(1));
    output(processes[0], 'already buffered');
    processes[0].kill.mockImplementation(() => {
      processes[0].close(0);
      return true;
    });
    expect(runner.cancel('sync')).toBe(true);
    expect(await result).toMatchObject({ status: 'rejected' });
    expect(onComplete).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(runner.cancel('sync')).toBe(false);
  });

  it('does not cancel an active channel when an idle channel is requested', async () => {
    const runner = create();
    const result = observe(runner.runStream('keep going', {}, { channelId: 'active' }));
    await vi.waitFor(() => expect(processes).toHaveLength(1));
    expect(runner.cancel('idle')).toBe(false);
    expect(processes[0].kill).not.toHaveBeenCalled();
    output(processes[0], 'done');
    processes[0].close();
    expect(await result).toMatchObject({ status: 'fulfilled', value: { result: 'done' } });
  });

  it('cancels a request without a channel before late successful output', async () => {
    const runner = create();
    const onComplete = vi.fn();
    const result = observe(runner.runStream('cancel', { onComplete }));
    await vi.waitFor(() => expect(processes).toHaveLength(1));
    expect(runner.cancel()).toBe(true);
    output(processes[0], 'late');
    processes[0].close();
    expect(await result).toMatchObject({ status: 'rejected' });
    expect(onComplete).not.toHaveBeenCalled();
  });
});

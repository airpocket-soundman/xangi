import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLineCompletionBridge, LineChatQueue } from '../src/line.js';
import {
  createTelegramCompletionBridge,
  TelegramChatQueue,
  registerTelegramSchedulerBridge,
} from '../src/telegram.js';
import {
  clearSessions,
  createSession,
  getActiveSessionId,
  getSessionEntry,
  initSessions,
} from '../src/sessions.js';
import type { Config } from '../src/config.js';
import type { AgentRunner } from '../src/agent-runner.js';
import { Scheduler } from '../src/scheduler.js';

const user = `U${'a'.repeat(32)}`;
describe('native completion bridges', () => {
  let data: string;
  beforeEach(() => {
    data = mkdtempSync(join(tmpdir(), 'completion-platform-'));
    initSessions(data);
  });
  afterEach(() => {
    clearSessions();
    rmSync(data, { recursive: true, force: true });
  });

  it.each(['line', 'telegram'] as const)(
    'serializes %s completion with incoming turns and recovers after failure',
    async (platform) => {
      const queue = platform === 'line' ? new LineChatQueue() : new TelegramChatQueue();
      const bridge =
        platform === 'line'
          ? createLineCompletionBridge({} as never, queue as LineChatQueue, ['*'])
          : createTelegramCompletionBridge(
              {} as never,
              {} as Config['telegram'],
              queue as TelegramChatQueue
            );
      const order: string[] = [];
      let release!: () => void;
      const incoming = queue.enqueue('same', async () => {
        order.push('incoming');
        await new Promise<void>((r) => {
          release = r;
        });
      });
      await vi.waitFor(() => expect(order).toEqual(['incoming']));
      expect(bridge.isBusy('same')).toBe(true);
      const continuation = bridge.enqueue('same', async () => {
        order.push('completion');
        return 42;
      });
      await Promise.resolve();
      expect(order).toEqual(['incoming']);
      release();
      await incoming;
      expect(await continuation).toBe(42);
      expect(order).toEqual(['incoming', 'completion']);
      await expect(
        bridge.enqueue('same', async () => {
          throw new Error('failed');
        })
      ).rejects.toThrow('failed');
      await expect(bridge.enqueue('same', async () => 43)).resolves.toBe(43);
      await vi.waitFor(() => expect(bridge.isBusy('same')).toBe(false));
    }
  );

  it('sends LINE completion to its parent and rejects a revoked destination without sending', async () => {
    const pushMessage = vi.fn().mockResolvedValue({});
    const parent = createSession(`line:${user}`, { platform: 'line' });
    const bridge = createLineCompletionBridge({ pushMessage } as never, new LineChatQueue(), [
      user,
    ]);
    await bridge.deliverResult({ appSessionId: parent, text: 'done', attachments: [] });
    expect(pushMessage).toHaveBeenCalledExactlyOnceWith({
      to: user,
      messages: [{ type: 'text', text: 'done' }],
    });
    const denied = createLineCompletionBridge({ pushMessage } as never, new LineChatQueue(), []);
    await expect(
      denied.deliverResult({ appSessionId: parent, text: 'denied', attachments: [] })
    ).rejects.toThrow('許可');
    expect(pushMessage).toHaveBeenCalledTimes(1);
  });

  it('routes Telegram results to the original forum topic and does not repeat an ambiguous send', async () => {
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 42 });
    const parent = createSession('telegram:chat:-123:topic:7', { platform: 'telegram' });
    const bridge = createTelegramCompletionBridge(
      { sendMessage } as never,
      { allowedChats: ['-123'], format: 'plain' } as Config['telegram']
    );
    expect(
      await bridge.deliverResult({ appSessionId: parent, text: 'done', attachments: [] })
    ).toEqual(['42']);
    expect(sendMessage).toHaveBeenCalledExactlyOnceWith('-123', 'done', { message_thread_id: 7 });
    sendMessage.mockRejectedValue(new Error('timeout after send'));
    await expect(
      bridge.deliverResult({ appSessionId: parent, text: 'again', attachments: [] })
    ).rejects.toThrow();
    expect(sendMessage).toHaveBeenCalledTimes(2);
    const denied = createTelegramCompletionBridge(
      { sendMessage } as never,
      { allowedChats: ['-999'] } as Config['telegram']
    );
    await expect(
      denied.deliverResult({ appSessionId: parent, text: 'denied', attachments: [] })
    ).rejects.toThrow('許可');
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it('runs Telegram schedules in fresh sessions, preserving the active conversation', async () => {
    const key = 'telegram:chat:-123:topic:7';
    const interactive = createSession(key, { platform: 'telegram' });
    const before = structuredClone(getSessionEntry(interactive));
    const scheduler = new Scheduler(data, { quiet: true });
    const runStream = vi
      .fn()
      .mockResolvedValue({ result: 'done', sessionId: 'scheduled-provider' });
    registerTelegramSchedulerBridge({
      scheduler,
      agentRunner: { runStream } as unknown as AgentRunner,
      config: { telegram: { format: 'plain' }, completion: {} } as Config,
      bot: {
        api: {
          sendMessage: vi.fn().mockResolvedValue({ chat: { id: -123 }, message_id: 1 }),
          editMessageText: vi.fn().mockResolvedValue({}),
        },
      } as never,
    });
    const run = scheduler.getAgentRunner('telegram')!;
    await run('first', key);
    await run('second', key);
    const options = runStream.mock.calls.map((call) => call[2]);
    expect(options[0].appSessionId).not.toBe(options[1].appSessionId);
    for (const opt of options) {
      expect(opt.sessionId).toBeUndefined();
      expect(opt.runnerKey).toBe(`schedule:${opt.appSessionId}`);
      expect(getSessionEntry(opt.appSessionId)).toMatchObject({
        scope: 'scheduler',
        closeReason: 'scheduled',
        agent: { providerSessionId: 'scheduled-provider' },
      });
    }
    expect(getActiveSessionId(key)).toBe(interactive);
    expect(getSessionEntry(interactive)).toEqual(before);
  });
});

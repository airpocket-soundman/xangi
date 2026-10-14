import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalLlmRunner } from '../src/local-llm/runner.js';
import { executeTool } from '../src/local-llm/tools.js';

let workspace: string;
beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'exec-context-'));
  vi.stubEnv('LOCAL_LLM_MODE', 'agent');
  vi.stubEnv('XANGI_CHANNEL_ID', 'stale-channel');
  vi.stubEnv('XANGI_PLATFORM', 'slack');
  writeFileSync(
    join(workspace, 'probe.cjs'),
    `require('node:fs').writeFileSync(process.argv[2], JSON.stringify({channel:process.env.XANGI_CHANNEL_ID,platform:process.env.XANGI_PLATFORM,workspace:process.env.WORKSPACE_PATH}));`
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(workspace, { recursive: true, force: true });
});

it.each([undefined, 'openrouter'] as const)(
  'passes per-conversation context through real shell execution (provider=%s)',
  async (provider) => {
    await Promise.all(
      ['first', 'second'].map(async (channelId) => {
        const runner = new LocalLlmRunner({
          workdir: workspace,
          model: 'test',
          platform: 'discord',
          provider,
        });
        const chat = vi
          .fn()
          .mockResolvedValueOnce({
            content: '',
            finishReason: 'tool_calls',
            toolCalls: [
              {
                id: 'probe',
                name: 'exec',
                arguments: { command: `node probe.cjs ${channelId}.json` },
              },
            ],
          })
          .mockResolvedValue({ content: 'done', finishReason: 'stop', toolCalls: [] });
        Object.assign(runner, { llm: { chat, chatStream: vi.fn() } });
        await runner.run('probe', { channelId, sessionId: channelId });
        expect(JSON.parse(readFileSync(join(workspace, `${channelId}.json`), 'utf8'))).toEqual({
          channel: channelId,
          platform: 'discord',
          workspace,
        });
      })
    );
    expect(process.env.XANGI_CHANNEL_ID).toBe('stale-channel');
    expect(process.env.XANGI_PLATFORM).toBe('slack');
  }
);

it('removes inherited conversation identity when context is absent', async () => {
  const result = await executeTool(
    'exec',
    { command: 'node probe.cjs missing.json' },
    { workspace }
  );
  expect(result.success).toBe(true);
  expect(JSON.parse(readFileSync(join(workspace, 'missing.json'), 'utf8'))).toEqual({ workspace });
});

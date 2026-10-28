import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeTool } from '../src/local-llm/tools.js';
import { LocalLlmRunner } from '../src/local-llm/runner.js';
import type { ChatPlatform } from '../src/prompts/index.js';

let root: string;
let workspace: string;
let external: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'xangi-permissions-'));
  workspace = join(root, 'workspace');
  external = join(root, 'external');
  mkdirSync(workspace);
  mkdirSync(external);
  symlinkSync(external, join(workspace, 'shared'));
  vi.stubEnv('LOCAL_LLM_TOOLS', 'true');
  vi.stubEnv('LOCAL_LLM_SKILLS', 'false');
  vi.stubEnv('LOCAL_LLM_XANGI_COMMANDS', 'false');
  vi.stubEnv('XANGI_TOOL_TRAJECTORY_LOG', 'false');
  vi.stubEnv('SKIP_PERMISSIONS', 'true');
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe('Local LLM unrestricted file access', () => {
  it.each(['shared/nested/file.txt', '../external/nested/file.txt'])(
    'creates, overwrites and edits %s without registration roots',
    async (path) => {
      const context = { workspace, skipPermissions: true };
      expect((await executeTool('write', { path, content: 'first' }, context)).success).toBe(true);
      expect((await executeTool('write', { path, content: 'second' }, context)).success).toBe(true);
      expect(
        (await executeTool('edit', { path, old_string: 'second', new_string: 'final' }, context))
          .success
      ).toBe(true);
      expect(await executeTool('read', { path }, context)).toMatchObject({
        success: true,
        output: 'final',
      });
      expect(readFileSync(join(external, 'nested/file.txt'), 'utf8')).toBe('final');
    }
  );

  it('searches and inspects images through external links without registration roots', async () => {
    const context = { workspace, skipPermissions: true };
    writeFileSync(join(external, 'note.md'), 'external marker');
    writeFileSync(
      join(external, 'pixel.png'),
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=',
        'base64'
      )
    );
    expect(await executeTool('glob', { pattern: '**/*.md' }, context)).toMatchObject({
      success: true,
      output: expect.stringContaining('note.md'),
    });
    expect(
      await executeTool('grep', { pattern: 'external marker', path: 'shared' }, context)
    ).toMatchObject({ success: true, output: expect.stringContaining('external marker') });
    expect(await executeTool('view_image', { path: 'shared/pixel.png' }, context)).toMatchObject({
      success: true,
      images: [expect.objectContaining({ mimeType: 'image/png' })],
    });
  });

  it('keeps explicit restricted contexts restricted even when the process default skips permissions', async () => {
    expect(
      (
        await executeTool(
          'write',
          { path: 'shared/blocked.txt', content: 'no' },
          { workspace, skipPermissions: false }
        )
      ).success
    ).toBe(false);
    expect(existsSync(join(external, 'blocked.txt'))).toBe(false);
  });
});

const platforms: ChatPlatform[] = ['discord', 'slack', 'web', 'line', 'telegram'];
for (const provider of [undefined, 'openrouter'] as const) {
  describe(`${provider ?? 'local-llm'} permission propagation`, () => {
    it.each(platforms)(
      'allows external writes from %s with the default permission setting',
      async (platform) => {
        const runner = new LocalLlmRunner({
          workdir: workspace,
          model: 'test',
          platform,
          provider,
        });
        const chat = vi
          .fn()
          .mockResolvedValueOnce({
            content: '',
            finishReason: 'tool_calls',
            toolCalls: [
              {
                id: 'write',
                name: 'write',
                arguments: { path: 'shared/result.txt', content: 'written' },
              },
            ],
          })
          .mockResolvedValue({ content: 'done', finishReason: 'stop', toolCalls: [] });
        (runner as unknown as { llm: { chat: typeof chat } }).llm = { chat };
        await runner.run('write the test file', { channelId: platform });
        expect(existsSync(join(external, 'result.txt'))).toBe(true);
        expect(readFileSync(join(external, 'result.txt'), 'utf8')).toBe('written');
      }
    );

    it.each([
      { config: true, override: false, allowed: false },
      { config: false, override: true, allowed: true },
      { config: false, override: undefined, allowed: false },
    ])(
      'honors streaming config=$config / per-call override=$override',
      async ({ config, override, allowed }) => {
        const runner = new LocalLlmRunner({
          workdir: workspace,
          model: 'test',
          provider,
          skipPermissions: config,
        });
        const chat = vi
          .fn()
          .mockResolvedValueOnce({
            content: '',
            finishReason: 'tool_calls',
            toolCalls: [
              {
                id: 'write',
                name: 'write',
                arguments: { path: 'shared/result.txt', content: 'written' },
              },
            ],
          })
          .mockResolvedValue({ content: 'done', finishReason: 'stop', toolCalls: [] });
        const chatStream = vi.fn(async function* () {
          yield 'done';
        });
        (runner as unknown as { llm: { chat: typeof chat; chatStream: typeof chatStream } }).llm = {
          chat,
          chatStream,
        };
        await runner.runStream(
          'write the test file',
          {},
          { channelId: 'stream', skipPermissions: override }
        );
        expect(existsSync(join(external, 'result.txt'))).toBe(allowed);
      }
    );
  });
}

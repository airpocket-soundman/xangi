import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AntigravityRunner } from '../src/antigravity-cli.js';
import { getSafeEnv } from '../src/safe-env.js';
import { configuredBackendCommand } from '../src/setup/backend-executable.js';
import {
  hasWorkspaceWriteRecovery,
  requireWorkspaceTestAgyVersion,
} from './helpers/antigravity-workspace.js';

// Opt in explicitly: these tests use the installed, authenticated CLI and consume AI quota.
describe.skipIf(process.env.XANGI_TEST_AGY_LIVE !== 'true')('live Agy workspace writes', () => {
  beforeAll(async () => {
    const env = getSafeEnv();
    let version: string;
    try {
      const { stdout } = await promisify(execFile)(
        configuredBackendCommand('agy', env),
        ['--version'],
        {
          env,
          timeout: 5_000,
          maxBuffer: 16 * 1024,
        }
      );
      version = stdout;
    } catch (cause) {
      throw new Error('Could not run agy --version; workspace tests require Agy >= 1.4.3', {
        cause,
      });
    }
    console.info(`[agy workspace test] Agy ${requireWorkspaceTestAgyVersion(version)}`);
  }, 10_000);

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each(['json', 'stream-json'] as const)(
    'creates, edits, and creates an empty workspace file via %s',
    async (format) => {
      const workdir = await mkdtemp(join(tmpdir(), 'xangi-agy-workspace-'));
      const marker = `AGY_WORKSPACE_${format === 'json' ? 'JSON' : 'STREAM'}_OK`;
      // Passed to Agy via getSafeEnv: redirects statusline helpers that honor inherited DATA_DIR.
      // Does not override fixed helper paths or isolate already-imported xangi modules.
      vi.stubEnv('DATA_DIR', join(workdir, '.xangi'));
      vi.stubEnv('ANTIGRAVITY_PRINT_TIMEOUT', '90s');
      const runner = new AntigravityRunner({
        workdir,
        timeoutMs: 120_000,
        skipPermissions: true,
        antigravityMode: 'accept-edits',
      });
      const warnings = vi.spyOn(console, 'warn');
      try {
        await writeFile(join(workdir, 'edit.txt'), 'before\n', 'utf8');
        const prompt = [
          'This is a workspace file-write compatibility test. Work only in the current directory.',
          'Do not use shell commands, subagents, network tools, or MCP tools.',
          'Use write_to_file to create created.txt with exactly "created\\n".',
          'Use the file editing tool to change edit.txt from "before\\n" to "after\\n".',
          'Use write_to_file to create empty.txt as a zero-byte file.',
          'These are ordinary workspace files, not artifacts. Do not modify any other files.',
          `After completing all three operations, reply with exactly ${marker}.`,
        ].join('\n');
        const onText = vi.fn();
        const onError = vi.fn();
        const result =
          format === 'json'
            ? await runner.run(prompt)
            : await runner.runStream(prompt, { onText, onError });

        expect(await readFile(join(workdir, 'created.txt'), 'utf8')).toBe('created\n');
        expect(await readFile(join(workdir, 'edit.txt'), 'utf8')).toBe('after\n');
        expect((await stat(join(workdir, 'empty.txt'))).size).toBe(0);
        expect(result.result).toContain(marker);
        expect(result.sessionId).toBeTruthy();
        expect(onError).not.toHaveBeenCalled();
        if (format === 'stream-json') {
          expect(onText.mock.calls.map(([text]) => text).join('')).toContain(marker);
        }
        expect(hasWorkspaceWriteRecovery(warnings.mock.calls)).toBe(false);
      } finally {
        runner.cancel();
        warnings.mockRestore();
        await rm(workdir, { recursive: true, force: true });
      }
    },
    150_000
  );
});

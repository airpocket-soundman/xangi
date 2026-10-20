import { vi } from 'vitest';
import { run } from '../../src/cli/xangi.js';

/**
 * Exercise the real argument parser, dispatcher and HTTP client without repeatedly
 * booting Node/tsx. Launcher, stdin, exit-code and installation tests still spawn
 * the CLI. Call sequentially: console and environment are process-global.
 */
export async function runCliInProcess(
  args: string[],
  env: Record<string, string> = {}
): Promise<string> {
  const originalEnv = { ...process.env };
  const lines: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((...values) => {
    lines.push(values.join(' '));
  });
  try {
    Object.assign(process.env, { XANGI_SKIP_ENV_FILE: 'true', ...env });
    await run(['node', 'xangi', ...args]);
    return lines.join('\n') + '\n';
  } finally {
    log.mockRestore();
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
  }
}

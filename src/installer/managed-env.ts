import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readEnvFile } from '../env-file.js';
import { resolveWebChatPort } from '../web-endpoint-config.js';

export function managedEnvPath(configPath: string): string {
  return join(dirname(configPath), 'runtime.env');
}

/** Create the persistent settings file without replacing existing settings. */
export function ensureManagedEnv(configPath: string): string {
  const target = managedEnvPath(configPath);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  try {
    writeFileSync(target, '', { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  return target;
}

export function managedHealthUrl(configPath: string): string {
  const { port } = resolveWebChatPort(undefined, readEnvFile(managedEnvPath(configPath)));
  return `http://127.0.0.1:${port}/health`;
}

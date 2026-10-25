import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config as dotenvConfig, parse } from 'dotenv';

export function resolveEnvFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return env.XANGI_ENV_PATH || join(process.cwd(), '.env');
}

export function readEnvFile(path: string): Record<string, string> {
  try {
    return parse(readFileSync(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
}

/** Match startup precedence without changing the caller's environment. */
export function readRuntimeEnv(
  path: string,
  env: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  return { ...env, ...readEnvFile(path) };
}

/** Use the same path for startup and the settings editor. */
export function loadRuntimeEnvFile(options: { quiet?: boolean } = {}): void {
  // Only managed installations pin setup paths. Checkout/Docker env files may
  // select their own setup or explicitly disable an inherited setup with blanks.
  const controls = ['XANGI_ENV_PATH', 'XANGI_INSTALLATION_KIND'];
  if (process.env.XANGI_INSTALLATION_KIND === 'managed') {
    controls.push('XANGI_SETUP_CONFIG_PATH', 'XANGI_SETUP_STATE_DIR');
  }
  const before = controls.map((key) => process.env[key]);
  dotenvConfig({ path: resolveEnvFilePath(), override: true, ...options });
  controls.forEach((key, index) => {
    if (before[index] === undefined) delete process.env[key];
    else process.env[key] = before[index];
  });
}

import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as os from 'os';
import { checkoutRuntimeEnv } from '../src/cli/service-cmd.js';
import { resolveAppLayout } from '../src/installer/layout.js';

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: vi.fn(actual.homedir), platform: vi.fn(actual.platform) };
});

const originalEnv = { ...process.env };
const roots: string[] = [];
afterEach(() => {
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'service-env-'));
  roots.push(root);
  vi.mocked(os.homedir).mockReturnValue(root);
  process.env.XDG_CONFIG_HOME = join(root, 'config');
  const layout = resolveAppLayout({
    platform: os.platform() as 'linux' | 'darwin',
    arch: 'arm64',
    homeDir: root,
    xdgConfigHome: process.env.XDG_CONFIG_HOME,
  });
  mkdirSync(layout.configDir, { recursive: true });
  writeFileSync(
    layout.configFile,
    JSON.stringify({ backend: 'codex', workspacePath: join(root, 'shared'), webChatEnabled: true })
  );
  const dir = join(root, 'checkout');
  mkdirSync(dir);
  writeFileSync(join(dir, '.git'), 'gitdir: /test/worktree');
  process.env.XANGI_SETUP_CONFIG_PATH = '/inherited/config.json';
  process.env.XANGI_SETUP_STATE_DIR = '/inherited/state';
  return { root, dir, config: layout.configFile };
}

describe.each(['linux', 'darwin'] as const)(
  'PM2 checkout setup selection (%s)',
  (targetPlatform) => {
    beforeEach(() => {
      vi.mocked(os.platform).mockReturnValue(targetPlatform);
    });
    it('honors an empty opt-out before reading even a malformed shared config', () => {
      const { dir, config } = fixture();
      writeFileSync(config, 'invalid JSON');
      writeFileSync(join(dir, '.env'), 'XANGI_SETUP_CONFIG_PATH=\nXANGI_SETUP_STATE_DIR=\n');
      expect(checkoutRuntimeEnv({ dir })).toMatchObject({
        XANGI_SETUP_CONFIG_PATH: '',
        XANGI_SETUP_STATE_DIR: '',
      });
    });
    it('uses the target checkout setup pair instead of the shared or caller setup', () => {
      const { dir } = fixture();
      writeFileSync(
        join(dir, '.env'),
        'XANGI_SETUP_CONFIG_PATH=/own/config.json\nXANGI_SETUP_STATE_DIR=/own/state\n'
      );
      expect(checkoutRuntimeEnv({ dir })).toMatchObject({
        XANGI_SETUP_CONFIG_PATH: '/own/config.json',
        XANGI_SETUP_STATE_DIR: '/own/state',
      });
    });
    it('rejects a partial pair without borrowing the missing value from the caller', () => {
      const { dir } = fixture();
      writeFileSync(join(dir, '.env'), 'XANGI_SETUP_CONFIG_PATH=/own/config.json\n');
      expect(() => checkoutRuntimeEnv({ dir })).toThrow('must be provided together');
    });
    it('does not apply a shared setup belonging to a different workspace', () => {
      const { root, dir } = fixture();
      writeFileSync(join(dir, '.env'), `WORKSPACE_PATH=${root}/own\nDATA_DIR=${root}/own-state\n`);
      expect(checkoutRuntimeEnv({ dir })).toMatchObject({
        XANGI_SETUP_CONFIG_PATH: '',
        XANGI_SETUP_STATE_DIR: '',
      });
    });
    it('retains shared setup for its own workspace and preserves the explicit state directory', () => {
      const { root, dir, config } = fixture();
      writeFileSync(
        join(dir, '.env'),
        `WORKSPACE_PATH=${root}/shared\nDATA_DIR=${root}/own-state\n`
      );
      expect(checkoutRuntimeEnv({ dir })).toMatchObject({
        XANGI_SETUP_CONFIG_PATH: config,
        XANGI_SETUP_STATE_DIR: `${root}/own-state`,
      });
    });
    it('does not inherit managed mode or an env file from the caller', () => {
      const { dir } = fixture();
      process.env.XANGI_INSTALLATION_KIND = 'managed';
      process.env.XANGI_ENV_PATH = '/caller/runtime.env';
      writeFileSync(join(dir, '.env'), 'XANGI_SETUP_CONFIG_PATH=\nXANGI_SETUP_STATE_DIR=\n');
      expect(checkoutRuntimeEnv({ dir, name: 'target-bot' })).toMatchObject({
        XANGI_INSTALLATION_KIND: 'checkout',
        XANGI_ENV_PATH: '',
        XANGI_PROCESS_NAME: 'target-bot',
      });
    });
    it('clears caller setup when no local or shared setup exists', () => {
      const { dir, config } = fixture();
      rmSync(config);
      expect(checkoutRuntimeEnv({ dir })).toMatchObject({
        XANGI_SETUP_CONFIG_PATH: '',
        XANGI_SETUP_STATE_DIR: '',
      });
    });
    it('does not inherit runtime settings, credentials or future settings absent from the target', () => {
      const { dir, config } = fixture();
      rmSync(config);
      Object.assign(process.env, {
        REMOTE_WORKER_ENABLED: 'true',
        REMOTE_WORKER_PORT: '18791',
        DISCORD_TOKEN: 'caller-secret',
        FUTURE_FEATURE_ENABLED: 'true',
        WORKSPACE_PATH: '/caller/workspace',
        DATA_DIR: '/caller/state',
        XANGI_PROCESS_NAME: 'caller',
        XANGI_TOOL_SERVER: 'http://caller',
      });
      const env = checkoutRuntimeEnv({ dir });
      for (const key of [
        'REMOTE_WORKER_ENABLED',
        'REMOTE_WORKER_PORT',
        'DISCORD_TOKEN',
        'FUTURE_FEATURE_ENABLED',
        'WORKSPACE_PATH',
        'DATA_DIR',
        'XANGI_TOOL_SERVER',
      ]) {
        expect(env[key], key).toBeUndefined();
      }
      expect(env.XANGI_PROCESS_NAME).toBe('checkout');
      expect(env.PATH).toBe(process.env.PATH);
    });
    it('loads the complete target env with dotenv syntax and keeps supervisor routing', () => {
      const { dir, config } = fixture();
      rmSync(config);
      process.env.PM2_HOME = '/isolated/pm2';
      writeFileSync(
        join(dir, '.env'),
        'export XANGI_PROCESS_NAME="target"\nREMOTE_WORKER_PORT=19999 # target\nDISCORD_TOKEN="target-secret"\n'
      );
      expect(checkoutRuntimeEnv({ dir })).toMatchObject({
        XANGI_PROCESS_NAME: 'target',
        REMOTE_WORKER_PORT: '19999',
        DISCORD_TOKEN: 'target-secret',
        PM2_HOME: '/isolated/pm2',
      });
    });
  }
);

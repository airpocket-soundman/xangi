import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  statSync,
  symlinkSync,
  unlinkSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ensureManagedEnv, managedHealthUrl } from '../src/installer/managed-env.js';
import { readEnvFile, loadRuntimeEnvFile } from '../src/env-file.js';
import { updateEnvKeyValue } from '../src/env-persist.js';
import {
  runConfiguredRuntime,
  applySetupRuntimeEnvFromProcess,
} from '../src/installer/runtime-config.js';
import { createDarwinServiceAdapter } from '../src/installer/platform/darwin.js';
import { updateWebStartupSetting } from '../src/web-startup-settings.js';

const originalEnv = { ...process.env };
const roots: string[] = [];
afterEach(() => {
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'managed-env-'));
  roots.push(root);
  for (const dir of ['config', 'state', 'app/v1', 'app/v2'])
    mkdirSync(join(root, dir), { recursive: true });
  const config = join(root, 'config/xangi.json');
  writeFileSync(
    config,
    JSON.stringify({
      backend: 'codex',
      workspacePath: root,
      webChatEnabled: true,
      webChatAccess: 'local',
    })
  );
  const current = join(root, 'app/current');
  symlinkSync(join(root, 'app/v1'), current);
  return { root, config, current };
}

describe('managed settings persistence', () => {
  it('creates a writable settings file for a clean install and reads the same explicit path', () => {
    const { config } = fixture();
    const path = ensureManagedEnv(config);
    process.env.XANGI_ENV_PATH = path;
    updateWebStartupSetting({ key: 'WEB_CHAT_PORT', value: '18889' });
    expect(updateEnvKeyValue('DISCORD_STREAMING', 'false').ok).toBe(true);
    loadRuntimeEnvFile();
    expect(process.env.WEB_CHAT_PORT).toBe('18889');
    expect(process.env.DISCORD_STREAMING).toBe('false');
    expect(managedHealthUrl(config)).toBe('http://127.0.0.1:18889/health');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(() => updateWebStartupSetting({ key: 'WEB_CHAT_PORT', value: '65536' })).toThrow();
  });

  it('matches runtime inheritance when runtime.env has no port', async () => {
    const { root, config } = fixture();
    process.env.WEB_CHAT_PORT = '19995';
    await runConfiguredRuntime(config, join(root, 'state'), join(root, 'index.js'), async () => {
      expect(managedHealthUrl(config)).toBe(`http://127.0.0.1:${process.env.WEB_CHAT_PORT}/health`);
      return {};
    });
  });

  it('persists an inherited port for service restarts without the original environment', () => {
    const { config } = fixture();
    process.env.WEB_CHAT_PORT = '23456';
    const path = ensureManagedEnv(config);
    delete process.env.WEB_CHAT_PORT;
    expect(readEnvFile(path).WEB_CHAT_PORT).toBe('23456');
    expect(managedHealthUrl(config)).toBe('http://127.0.0.1:23456/health');
    process.env.WEB_CHAT_PORT = '34567';
    ensureManagedEnv(config);
    expect(readEnvFile(path).WEB_CHAT_PORT).toBe('23456');
  });

  it.each(['', 'invalid', '65536'])('does not persist an invalid inherited port: %s', (port) => {
    const { config } = fixture();
    process.env.WEB_CHAT_PORT = port;
    expect(readEnvFile(ensureManagedEnv(config)).WEB_CHAT_PORT).toBeUndefined();
    expect(managedHealthUrl(config)).toBe('http://127.0.0.1:18888/health');
  });

  it('keeps saved values across version switches and service regeneration', async () => {
    const { root, config, current } = fixture();
    const path = ensureManagedEnv(config);
    writeFileSync(path, 'WEB_CHAT_PORT=18889\nDISCORD_STREAMING=false\n');
    process.env.XANGI_ENV_PATH = path;
    expect(updateEnvKeyValue('WEB_CHAT_PORT', '19999').ok).toBe(true);
    unlinkSync(current);
    symlinkSync(join(root, 'app/v2'), current);
    const service = createDarwinServiceAdapter(
      {
        label: 'test',
        nodePath: '/test/node',
        entrypoint: '/test/index.js',
        configLoaderPath: '/test/loader.js',
        configPath: config,
        stateDir: join(root, 'state'),
        workingDirectory: current,
        stdoutPath: join(root, 'stdout'),
        stderrPath: join(root, 'stderr'),
        path: '/usr/bin',
        plistPath: join(root, 'service.plist'),
        autostartPlistPath: join(root, 'autostart.plist'),
      },
      { run: vi.fn(), status: () => ({ status: 0, output: '' }) }
    );
    await service.install();
    await service.autostart(true);
    expect(ensureManagedEnv(config)).toBe(path);
    loadRuntimeEnvFile();
    expect(process.env.WEB_CHAT_PORT).toBe('19999');
    expect(process.env.DISCORD_STREAMING).toBe('false');
    expect(readEnvFile(path).WEB_CHAT_PORT).toBe('19999');
  });

  it('applies setup after advanced settings on both managed entrypoint and main startup', async () => {
    const { root, config, current } = fixture();
    writeFileSync(
      ensureManagedEnv(config),
      'AGENT_BACKEND=claude-code\nWEB_CHAT_HOST=0.0.0.0\nWEB_CHAT_PORT=18889\nDATA_DIR=/wrong\n'
    );
    await runConfiguredRuntime(
      config,
      join(root, 'state'),
      join(current, 'dist', 'index.js'),
      async () => {
        loadRuntimeEnvFile();
        await applySetupRuntimeEnvFromProcess();
        expect(process.env.AGENT_BACKEND).toBe('codex');
        expect(process.env.WEB_CHAT_HOST).toBe('127.0.0.1');
        expect(process.env.DATA_DIR).toBe(join(root, 'state'));
        expect(process.env.WEB_CHAT_PORT).toBe('18889');
        return {};
      }
    );
  });
});

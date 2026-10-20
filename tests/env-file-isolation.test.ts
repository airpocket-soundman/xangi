import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadRuntimeEnvFile } from '../src/env-file.js';
import {
  applySetupRuntimeEnvFromProcess,
  runConfiguredRuntime,
} from '../src/installer/runtime-config.js';

const originalEnv = { ...process.env };
const roots: string[] = [];
afterEach(() => {
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'env-isolation-'));
  roots.push(root);
  delete process.env.XANGI_INSTALLATION_KIND;
  return root;
}

describe('checkout and managed environment isolation', () => {
  it.each(['cwd', 'explicit'])(
    'honors checkout setup opt-out using the %s env path',
    async (mode) => {
      const root = fixture();
      const path = join(root, '.env');
      writeFileSync(
        path,
        'XANGI_SETUP_CONFIG_PATH=\nXANGI_SETUP_STATE_DIR=\nWORKSPACE_PATH=/own/workspace\nDATA_DIR=/own/state\n'
      );
      process.env.XANGI_SETUP_CONFIG_PATH = '/other/config.json';
      process.env.XANGI_SETUP_STATE_DIR = '/other/state';
      if (mode === 'explicit') process.env.XANGI_ENV_PATH = path;
      else {
        delete process.env.XANGI_ENV_PATH;
        vi.spyOn(process, 'cwd').mockReturnValue(root);
      }
      loadRuntimeEnvFile();
      expect(await applySetupRuntimeEnvFromProcess()).toBe(false);
      expect(process.env.WORKSPACE_PATH).toBe('/own/workspace');
      expect(process.env.DATA_DIR).toBe('/own/state');
    }
  );

  it('accepts a checkout-specific setup pair supplied by its env file', async () => {
    const root = fixture();
    const config = join(root, 'xangi.json');
    writeFileSync(
      config,
      JSON.stringify({ backend: 'codex', workspacePath: root, webChatEnabled: true })
    );
    process.env.XANGI_ENV_PATH = join(root, '.env');
    delete process.env.XANGI_SETUP_CONFIG_PATH;
    delete process.env.XANGI_SETUP_STATE_DIR;
    writeFileSync(
      process.env.XANGI_ENV_PATH,
      `XANGI_SETUP_CONFIG_PATH=${config}\nXANGI_SETUP_STATE_DIR=${root}/state\n`
    );
    loadRuntimeEnvFile();
    expect(await applySetupRuntimeEnvFromProcess()).toBe(true);
    expect(process.env.WORKSPACE_PATH).toBe(root);
  });

  it('pins managed setup and file selection across both startup reads', async () => {
    const root = fixture();
    const config = join(root, 'xangi.json');
    writeFileSync(
      config,
      JSON.stringify({ backend: 'codex', workspacePath: root, webChatEnabled: true })
    );
    writeFileSync(
      join(root, 'runtime.env'),
      'XANGI_INSTALLATION_KIND=checkout\nXANGI_ENV_PATH=/wrong.env\nXANGI_SETUP_CONFIG_PATH=\nXANGI_SETUP_STATE_DIR=\nWORKSPACE_PATH=/wrong\nWEB_CHAT_PORT=19999\n'
    );
    await runConfiguredRuntime(config, join(root, 'state'), join(root, 'index.js'), async () => {
      loadRuntimeEnvFile();
      await applySetupRuntimeEnvFromProcess();
      expect(process.env.WORKSPACE_PATH).toBe(root);
      expect(process.env.XANGI_ENV_PATH).toBe(join(root, 'runtime.env'));
      expect(process.env.XANGI_INSTALLATION_KIND).toBe('managed');
      expect(process.env.WEB_CHAT_PORT).toBe('19999');
    });
  });
});

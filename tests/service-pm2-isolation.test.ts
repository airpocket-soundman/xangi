import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createServer } from 'node:net';
import { collectDoctorChecks } from '../src/cli/doctor-cmd.js';

// Opt-in: needs a local PM2 executable. Never uses the user's PM2 daemon.
describe.skipIf(process.env.XANGI_TEST_PM2 !== 'true')('real PM2 environment isolation', () => {
  it('replaces polluted registrations, removes deleted settings, and survives save/resurrect', async () => {
    const root = mkdtempSync(join(tmpdir(), 'xpm2-'));
    const target = join(root, 'target');
    const snapshot = join(target, 'snapshot.json');
    mkdirSync(join(target, 'dist'), { recursive: true });
    mkdirSync(join(target, '.git'));
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: root,
      USER: process.env.USER,
      PM2_HOME: join(root, 'pm2'),
      XDG_CONFIG_HOME: join(root, 'config'),
      XDG_DATA_HOME: join(root, 'data'),
      XDG_STATE_HOME: join(root, 'state'),
      XANGI_PROCESS_NAME: 'caller',
      REMOTE_WORKER_ENABLED: 'true',
      REMOTE_WORKER_PORT: '18791',
      DISCORD_TOKEN: 'caller-token',
      FUTURE_FEATURE_ENABLED: 'caller',
      WORKSPACE_PATH: '/caller/workspace',
      DATA_DIR: '/caller/state',
      XANGI_ENV_PATH: join(root, 'caller.env'),
    };
    writeFileSync(env.XANGI_ENV_PATH!, 'XANGI_PROCESS_NAME=wrong\n');
    copyFileSync(resolve('ecosystem.config.cjs'), join(target, 'ecosystem.config.cjs'));
    writeFileSync(
      join(target, 'dist/index.js'),
      `
      const fs = require('node:fs');
      const keys = ['REMOTE_WORKER_ENABLED', 'REMOTE_WORKER_PORT', 'DISCORD_TOKEN',
        'FUTURE_FEATURE_ENABLED', 'WORKSPACE_PATH', 'DATA_DIR', 'XANGI_PROCESS_NAME'];
      fs.writeFileSync('snapshot.json', JSON.stringify(Object.fromEntries(keys.map(k => [k, process.env[k] ?? null]))));
      setInterval(() => {}, 1000);
    `
    );
    const writeTargetEnv = (extra = '') =>
      writeFileSync(
        join(target, '.env'),
        `XANGI_PROCESS_NAME=target\nXANGI_SETUP_CONFIG_PATH=\nXANGI_SETUP_STATE_DIR=\nDISCORD_TOKEN=target-token\n${extra}`
      );
    function command(executable: string, args: string[], commandEnv = env) {
      const result = spawnSync(executable, args, {
        cwd: target,
        env: commandEnv,
        encoding: 'utf8',
        timeout: 20_000,
      });
      expect(
        result.status,
        `${executable} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`
      ).toBe(0);
      return result.stdout;
    }
    const pm2 = (...args: string[]) => command('pm2', args);
    const cli = (...args: string[]) =>
      command(resolve('bin/xangi'), ['service', ...args, '--dir', target]);
    async function readSnapshot() {
      const until = Date.now() + 5_000;
      while (!existsSync(snapshot) && Date.now() < until)
        await new Promise((r) => setTimeout(r, 25));
      expect(existsSync(snapshot)).toBe(true);
      return JSON.parse(readFileSync(snapshot, 'utf8'));
    }
    const cleanSnapshot = {
      REMOTE_WORKER_ENABLED: null,
      REMOTE_WORKER_PORT: null,
      DISCORD_TOKEN: 'target-token',
      FUTURE_FEATURE_ENABLED: null,
      WORKSPACE_PATH: null,
      DATA_DIR: null,
      XANGI_PROCESS_NAME: 'target',
    };
    try {
      writeTargetEnv();
      // A direct PM2 start bypasses the service boundary: reproduce the original leak.
      pm2('start', 'ecosystem.config.cjs');
      expect(await readSnapshot()).toMatchObject({
        REMOTE_WORKER_PORT: '18791',
        FUTURE_FEATURE_ENABLED: 'caller',
      });
      pm2('delete', 'caller');
      rmSync(snapshot);
      // Seed an old polluted registration under the correct name as well.
      command('pm2', ['start', 'ecosystem.config.cjs'], { ...env, XANGI_PROCESS_NAME: 'target' });
      expect(await readSnapshot()).toMatchObject({ REMOTE_WORKER_PORT: '18791' });
      rmSync(snapshot);
      cli('restart');
      expect(await readSnapshot()).toEqual(cleanSnapshot);
      cli('status');

      rmSync(snapshot);
      pm2('restart', 'target', '--update-env');
      expect(await readSnapshot()).toMatchObject({ REMOTE_WORKER_PORT: '18791' });
      pm2('save');
      pm2('kill');
      rmSync(snapshot);
      pm2('resurrect');
      expect(await readSnapshot()).toMatchObject({ REMOTE_WORKER_PORT: '18791' });
      rmSync(snapshot);
      cli('restart');
      expect(await readSnapshot()).toEqual(cleanSnapshot);

      writeTargetEnv('REMOTE_WORKER_PORT=19999\nFUTURE_FEATURE_ENABLED=target\n');
      rmSync(snapshot);
      cli('restart');
      expect(await readSnapshot()).toMatchObject({
        REMOTE_WORKER_PORT: '19999',
        FUTURE_FEATURE_ENABLED: 'target',
      });
      writeTargetEnv();
      rmSync(snapshot);
      cli('restart');
      expect(await readSnapshot()).toEqual(cleanSnapshot);

      cli('stop');
      rmSync(snapshot);
      cli('start');
      expect(await readSnapshot()).toEqual(cleanSnapshot);
      pm2('save');
      pm2('kill');
      rmSync(snapshot);
      pm2('resurrect');
      expect(await readSnapshot()).toEqual(cleanSnapshot);

      // Explicit name is an operation argument, never borrowed from the caller.
      cli('stop');
      rmSync(snapshot);
      cli('start', '--name', 'explicit-target');
      expect(await readSnapshot()).toMatchObject({
        ...cleanSnapshot,
        XANGI_PROCESS_NAME: 'explicit-target',
      });
    } finally {
      // The short, freshly created PM2_HOME confines cleanup to this test.
      const cleanup = spawnSync('pm2', ['kill'], { env, encoding: 'utf8', timeout: 20_000 });
      expect(cleanup.status, cleanup.stderr).toBe(0);
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);

  it('boots the built application and diagnoses the actual target HTTP port', async () => {
    expect(
      existsSync(resolve('dist/index.js')),
      'run npm run build before the PM2 integration tests'
    ).toBe(true);
    const root = mkdtempSync(join(tmpdir(), 'xhttp-'));
    const reservation = createServer();
    await new Promise<void>((r) => reservation.listen(0, '127.0.0.1', r));
    const port = (reservation.address() as { port: number }).port;
    await new Promise<void>((r) => reservation.close(() => r()));
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: root,
      USER: process.env.USER,
      PM2_HOME: join(root, 'pm2'),
      XDG_CONFIG_HOME: join(root, 'config'),
      XDG_DATA_HOME: join(root, 'data'),
      XDG_STATE_HOME: join(root, 'state'),
      WEB_CHAT_PORT: '1',
      REMOTE_WORKER_ENABLED: 'true',
      REMOTE_WORKER_PORT: '18791',
      DISCORD_TOKEN: 'caller-token',
      FUTURE_FEATURE_ENABLED: 'caller',
    };
    symlinkSync(resolve('dist'), join(root, 'dist'), 'dir');
    copyFileSync(resolve('ecosystem.config.cjs'), join(root, 'ecosystem.config.cjs'));
    writeFileSync(
      join(root, '.env'),
      [
        'XANGI_PROCESS_NAME=http-target',
        'XANGI_SETUP_CONFIG_PATH=',
        'XANGI_SETUP_STATE_DIR=',
        'WEB_CHAT_ENABLED=true',
        'WEB_CHAT_HOST=127.0.0.1',
        `WEB_CHAT_PORT=${port}`,
        `WORKSPACE_PATH=${root}`,
        `DATA_DIR=${join(root, 'state')}`,
        'AGENT_BACKEND=codex',
      ].join('\n')
    );
    try {
      const result = spawnSync(resolve('bin/xangi'), ['service', 'start', '--dir', root], {
        env,
        cwd: root,
        encoding: 'utf8',
        timeout: 20_000,
      });
      expect(result.status, result.stderr).toBe(0);
      let healthy = false;
      const until = Date.now() + 15_000;
      while (Date.now() < until) {
        try {
          healthy = (
            await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) })
          ).ok;
          if (healthy) break;
        } catch {
          /* Wait for this isolated application's startup. */
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      const logs = spawnSync('pm2', ['logs', 'http-target', '--nostream', '--lines', '15'], {
        env,
        encoding: 'utf8',
        timeout: 5_000,
      });
      expect(healthy, logs.stdout + logs.stderr).toBe(true);
      const checks = await collectDoctorChecks({
        homeDir: root,
        checkoutDir: root,
        platform: 'linux',
        arch: 'x64',
        serviceCheck: async () => ({ name: 'service', level: 'ok', detail: 'isolated PM2' }),
      });
      expect(checks.find((c) => c.name === 'health')).toMatchObject({
        level: 'ok',
        detail: `http://127.0.0.1:${port}/health: HTTP 200`,
      });
      const listing = spawnSync('pm2', ['jlist'], { env, encoding: 'utf8', timeout: 5_000 });
      expect(listing.status).toBe(0);
      const app = JSON.parse(listing.stdout).find(
        (p: { name: string }) => p.name === 'http-target'
      );
      expect(app.pm2_env.REMOTE_WORKER_ENABLED).toBeUndefined();
      expect(app.pm2_env.DISCORD_TOKEN).toBeUndefined();
      expect(app.pm2_env.FUTURE_FEATURE_ENABLED).toBeUndefined();
      expect(app.pm2_env.restart_time).toBe(0);
    } finally {
      const cleanup = spawnSync('pm2', ['kill'], { env, encoding: 'utf8', timeout: 20_000 });
      expect(cleanup.status, cleanup.stderr).toBe(0);
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});

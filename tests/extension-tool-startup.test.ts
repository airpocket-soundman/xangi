import { afterEach, expect, it, vi } from 'vitest';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { startToolServer, stopToolServer } from '../src/tool-server.js';
import { linkExtension, runExtensionAction, stopManagedExtensions } from '../src/extensions.js';

let root: string;
afterEach(async () => {
  await stopManagedExtensions();
  stopToolServer();
  vi.unstubAllEnvs();
  if (root) await rm(root, { recursive: true, force: true });
});

it('passes the actual listening URL to a managed child, including port fallback', async () => {
  root = await mkdtemp(join(tmpdir(), 'extension-tool-startup-'));
  vi.stubEnv('DATA_DIR', root);
  vi.stubEnv('XANGI_EXTENSIONS_FILE', join(root, 'extensions.json'));
  vi.stubEnv('XANGI_TOOL_SERVER', 'http://127.0.0.1:1');
  const occupied = createServer();
  await new Promise<void>((done) => occupied.listen(0, '0.0.0.0', done));
  const address = occupied.address();
  if (!address || typeof address === 'string') throw new Error('Missing test port');
  vi.stubEnv('XANGI_TOOL_SERVER_PORT', String(address.port));
  try {
    await startToolServer();
    expect(process.env.XANGI_TOOL_SERVER).not.toBe(`http://127.0.0.1:${address.port}`);
    expect(process.env.XANGI_TOOL_SERVER).not.toBe('http://127.0.0.1:1');
    const entrypoint = join(root, 'serve.mjs');
    await writeFile(
      entrypoint,
      `#!/usr/bin/env node
import http from 'node:http';
import { execFileSync } from 'node:child_process';
const output = execFileSync(${JSON.stringify(resolve('bin/xangi'))}, ['tool', 'help', 'trigger'], { encoding: 'utf8' });
if (!output.includes('trigger --channel')) process.exit(2);
const server = http.createServer((req, res) => res.end(JSON.stringify({ ready: true })));
server.listen(0, '127.0.0.1', () => console.log(JSON.stringify({
 schemaVersion: 2, event: 'ready', id: 'notify-test',
 baseUrl: 'http://127.0.0.1:' + server.address().port,
 workspace: process.argv[process.argv.indexOf('--workspace') + 1]
})));
process.stdin.resume();
process.stdin.on('end', () => server.close());
`
    );
    await chmod(entrypoint, 0o755);
    const manifestPath = join(root, 'xangi-extension.json');
    await writeFile(
      manifestPath,
      JSON.stringify({
        schemaVersion: 2,
        id: 'notify-test',
        displayName: 'Notify test',
        version: '0.1.0',
        entrypoint: 'serve.mjs',
        runtime: { kind: 'managed-http' },
        capabilities: [{ id: 'notify.test', protocol: 'http', healthPath: '/health' }],
      })
    );
    const linked = await linkExtension(manifestPath);
    await expect(runExtensionAction(linked, 'start', { workspace: root })).resolves.toMatchObject({
      ready: true,
    });
  } finally {
    await new Promise<void>((done) => occupied.close(() => done()));
  }
}, 30000);

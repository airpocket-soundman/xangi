import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  linkExtension,
  listExtensions,
  parseExtensionManifest,
  runExtensionAction,
  startAutostartExtensions,
  stopManagedExtensions,
} from '../src/extensions.js';

const original = process.env.XANGI_EXTENSIONS_FILE;
afterEach(async () => {
  await stopManagedExtensions();
  if (original === undefined) delete process.env.XANGI_EXTENSIONS_FILE;
  else process.env.XANGI_EXTENSIONS_FILE = original;
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'startup-groups-'));
  process.env.XANGI_EXTENSIONS_FILE = join(root, 'extensions.json');
  const events = join(root, 'events');
  await writeFile(events, '');
  const add = async (id: string, group: string | undefined, delay = 250, state = 'complete') => {
    const executable = join(root, id);
    await writeFile(
      executable,
      `#!/usr/bin/env node
import http from 'node:http';
import { appendFileSync } from 'node:fs';
const event = (name) => appendFileSync(${JSON.stringify(events)}, ${JSON.stringify(id)} + ':' + name + '\\n');
event('start');
let state = 'initializing';
const timer = setTimeout(() => { state = ${JSON.stringify(state)}; event('finish'); }, ${delay});
const server = http.createServer((req, res) => {
 if (req.headers.authorization !== 'Bearer ' + process.env.XANGI_EXTENSION_AUTH_TOKEN) { res.writeHead(401).end(); return; }
 res.writeHead(200, { 'Content-Type': 'application/json' });
 res.end(JSON.stringify(state === 'unknown' ? {ready: true} : {ready: false, startup: {state}}));
});
server.listen(0, '127.0.0.1', () => console.log(JSON.stringify({schemaVersion:2,event:'ready',id:${JSON.stringify(id)},workspace:process.argv[process.argv.indexOf('--workspace')+1],baseUrl:'http://127.0.0.1:'+server.address().port})));
process.stdin.resume();
process.stdin.on('end', () => { clearTimeout(timer); server.close(); });
`
    );
    await chmod(executable, 0o755);
    const manifest = {
      schemaVersion: 2,
      id,
      displayName: id,
      version: '1.0.0',
      runtime: { kind: 'managed-http' },
      entrypoint: id,
      ...(group ? { startup: { exclusiveGroup: group, timeoutSeconds: 1 } } : {}),
      capabilities: [{ id: 'test.' + id, protocol: 'http', healthPath: '/health' }],
    };
    const path = join(root, id + '.json');
    await writeFile(path, JSON.stringify(manifest));
    return { linked: await linkExtension(path), manifest, path };
  };
  return { root, events, add };
}

it('serializes only the same group through initialization, independently of readiness', async () => {
  const f = await setup();
  await f.add('first', 'gpu', 500);
  await f.add('second', 'gpu');
  await f.add('other', 'gpu:1');
  await f.add('legacy', undefined);
  await startAutostartExtensions({ workspace: f.root });
  const deadline = Date.now() + 3000;
  while (!(await readFile(f.events, 'utf8')).includes('first:finish') && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const events = (await readFile(f.events, 'utf8')).trim().split('\n');
  expect(events).toContain('first:finish');
  expect(events.indexOf('second:start')).toBeGreaterThan(events.indexOf('first:finish'));
  expect(events.indexOf('other:start')).toBeLessThan(events.indexOf('first:finish'));
  expect(events.indexOf('legacy:start')).toBeLessThan(events.indexOf('first:finish'));
});

it('retains the group after timeout; reports the blocker and permits retry after stop', async () => {
  const f = await setup();
  const a = await f.add('slow', 'gpu', 60_000);
  const b = await f.add('next', 'gpu');
  const timed = await runExtensionAction(a.linked, 'start', { workspace: f.root });
  expect(timed.ok).toBe(false);
  expect(timed.detail).toContain('timed out');
  const blocked = await runExtensionAction(b.linked, 'start', { workspace: f.root });
  expect(blocked.detail).toContain('blocked by slow');
  expect(await readFile(f.events, 'utf8')).not.toContain('next:start');
  await runExtensionAction(a.linked, 'stop');
  await runExtensionAction(b.linked, 'start', { workspace: f.root });
  expect(await readFile(f.events, 'utf8')).toContain('next:finish');
});

it('releases on an explicit terminal failure and returns failure to the caller', async () => {
  const f = await setup();
  const a = await f.add('failed', 'gpu', 100, 'failed');
  const b = await f.add('next', 'gpu');
  const [result] = await Promise.all([
    runExtensionAction(a.linked, 'start', { workspace: f.root }),
    runExtensionAction(b.linked, 'start', { workspace: f.root }),
  ]);
  expect(result.ok).toBe(false);
  expect(await readFile(f.events, 'utf8')).toContain('next:finish');
});

it('honors installation overrides and preserves them on relink', async () => {
  const f = await setup();
  const a = await f.add('one', 'gpu', 600);
  const b = await f.add('two', 'gpu', 600);
  const config = process.env.XANGI_EXTENSIONS_FILE!;
  const store = JSON.parse(await readFile(config, 'utf8'));
  store.extensions[0].startup = null;
  store.extensions[1].startup = { exclusiveGroup: 'gpu:1', timeoutSeconds: 1 };
  await writeFile(config, JSON.stringify(store));
  await linkExtension(a.path);
  const links = await listExtensions();
  expect(links.find((x) => x.id === 'one')?.startup).toBeNull();
  expect(links.find((x) => x.id === 'two')?.startup?.exclusiveGroup).toBe('gpu:1');
  await startAutostartExtensions({ workspace: f.root });
  await vi.waitFor(async () => expect(await readFile(f.events, 'utf8')).toContain('one:finish'), {
    timeout: 3000,
    interval: 20,
  });
  const events = (await readFile(f.events, 'utf8')).split('\n');
  expect(events.indexOf('two:start')).toBeLessThan(events.indexOf('one:finish'));
});

it('deduplicates concurrent starts and cancels queued work when stopped', async () => {
  const f = await setup();
  const a = await f.add('one', 'gpu', 500);
  const b = await f.add('two', 'gpu');
  const one = runExtensionAction(a.linked, 'start', { workspace: f.root });
  // Manifest reads are asynchronous: call order alone does not establish ownership.
  await vi.waitFor(async () => expect(await readFile(f.events, 'utf8')).toContain('one:start'), {
    timeout: 3000,
    interval: 20,
  });
  const duplicate = runExtensionAction(a.linked, 'start', { workspace: f.root });
  const two = runExtensionAction(b.linked, 'start', { workspace: f.root });
  await vi.waitFor(
    async () =>
      expect((await runExtensionAction(b.linked, 'status')).detail).toBe(
        'waiting for startup group gpu'
      ),
    { timeout: 3000, interval: 20 }
  );
  await runExtensionAction(b.linked, 'stop');
  await Promise.all([one, duplicate, two]);
  const events = await readFile(f.events, 'utf8');
  expect(events.match(/one:start/g)).toHaveLength(1);
  expect(events).not.toContain('two:start');
});

it('validates resource labels and timeout bounds', async () => {
  const f = await setup();
  const a = await f.add('one', 'gpu');
  for (const startup of [
    { exclusiveGroup: '' },
    { exclusiveGroup: 'gpu', timeoutSeconds: 0 },
    { exclusiveGroup: 'gpu', timeoutSeconds: Infinity },
    { exclusiveGroup: 'gpu', timeoutSeconds: 3601 },
  ]) {
    expect(() => parseExtensionManifest({ ...a.manifest, startup })).toThrow(/startup/);
  }
  expect(
    parseExtensionManifest({ ...a.manifest, startup: { exclusiveGroup: 'gpu:1' } }).startup
      ?.timeoutSeconds
  ).toBe(120);
});

it('keeps a missing initialization signal blocked even when HTTP is healthy', async () => {
  const f = await setup();
  const a = await f.add('unknown', 'gpu', 100, 'unknown');
  const result = await runExtensionAction(a.linked, 'start', { workspace: f.root });
  expect(result.detail).toContain('timed out');
  const b = await f.add('next', 'gpu');
  expect((await runExtensionAction(b.linked, 'start', { workspace: f.root })).detail).toContain(
    'blocked by unknown'
  );
});

it('can retry a blocked group after late initialization finishes without stopping the owner', async () => {
  const f = await setup();
  const a = await f.add('late', 'gpu', 1400);
  const b = await f.add('next', 'gpu');
  expect((await runExtensionAction(a.linked, 'start', { workspace: f.root })).detail).toContain(
    'timed out'
  );
  await vi.waitFor(async () => expect(await readFile(f.events, 'utf8')).toContain('late:finish'), {
    timeout: 3000,
    interval: 20,
  });
  expect((await runExtensionAction(b.linked, 'start', { workspace: f.root })).detail).not.toContain(
    'blocked'
  );
  expect(await readFile(f.events, 'utf8')).toContain('next:finish');
});

it('cancels initialization and queued starts during host shutdown', async () => {
  const f = await setup();
  const a = await f.add('one', 'gpu', 60_000);
  const b = await f.add('two', 'gpu');
  const one = runExtensionAction(a.linked, 'start', { workspace: f.root });
  await vi.waitFor(async () => expect(await readFile(f.events, 'utf8')).toContain('one:start'), {
    timeout: 3000,
    interval: 20,
  });
  const two = runExtensionAction(b.linked, 'start', { workspace: f.root });
  await vi.waitFor(
    async () =>
      expect((await runExtensionAction(b.linked, 'status')).detail).toBe(
        'waiting for startup group gpu'
      ),
    { timeout: 3000, interval: 20 }
  );
  await stopManagedExtensions();
  await Promise.all([one, two]);
  expect(await readFile(f.events, 'utf8')).not.toContain('two:start');
  expect((await runExtensionAction(a.linked, 'status')).running).toBe(false);
});

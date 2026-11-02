import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { linkExtension, listExtensions, runExtensionAction } from '../src/extensions.js';

it('starts an unexecutable .mjs entrypoint with Node and stops it through stdin', async () => {
  const root = await mkdtemp(join(tmpdir(), 'xangi-node-extension-'));
  const configPath = join(root, 'extensions.json');
  await writeFile(
    join(root, 'entry.mjs'),
    `
    import {createServer} from 'node:http';
    const server=createServer((req,res)=>{
      if(req.headers.authorization!=='Bearer '+process.env.XANGI_EXTENSION_AUTH_TOKEN){res.writeHead(401).end();return;}
      res.end(JSON.stringify({ok:true}));
    });
    server.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({schemaVersion:2,event:'ready',id:'node-entry',baseUrl:'http://127.0.0.1:'+server.address().port,workspace:process.argv[4]})));
    process.stdin.resume();process.stdin.on('end',()=>server.close());
  `,
    { mode: 0o644 }
  );
  const manifest = join(root, 'xangi-extension.json');
  await writeFile(
    manifest,
    JSON.stringify({
      schemaVersion: 2,
      id: 'node-entry',
      displayName: 'Node Entry',
      version: '0.1.0',
      entrypoint: 'entry.mjs',
      runtime: { kind: 'managed-http' },
      capabilities: [{ id: 'test', protocol: 'http', healthPath: '/health' }],
    })
  );
  const linked = await linkExtension(manifest, { configPath });
  expect((await listExtensions(configPath)).map((entry) => entry.id)).toEqual(['node-entry']);
  try {
    const started = await runExtensionAction(linked, 'start', { workspace: root });
    expect(started.healthy).toBe(true);
  } finally {
    const stopped = await runExtensionAction(linked, 'stop');
    expect(stopped.running).toBe(false);
  }
});

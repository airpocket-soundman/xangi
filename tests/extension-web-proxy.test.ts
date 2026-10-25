import { createServer, type Server } from 'http';
import { once } from 'events';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { attachExtensionWebSockets, proxyExtensionRequest } from '../src/extension-web-proxy.js';

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});
async function listen(server: Server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  cleanup.push(() => {
    server.closeAllConnections();
    server.close();
  });
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
async function gateway(baseUrl: string, device = false) {
  const resolve = async (id: string) => {
    if (!(device ? ['sample-watch'] : ['one', 'two']).includes(id)) throw Error('not installed');
    return { baseUrl, authorization: `Bearer private-${id}` };
  };
  const server = createServer((req, res) => {
    void proxyExtensionRequest(req, res, resolve, device).then((handled) => {
      if (!handled) res.writeHead(404).end();
    });
  });
  attachExtensionWebSockets(server, resolve);
  return listen(server);
}

describe('extension service proxy', () => {
  it('preserves binary bodies, method/query and isolates credentials and cookies', async () => {
    let seen: any;
    const base = await listen(
      createServer(async (req, res) => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk);
        seen = {
          method: req.method,
          url: req.url,
          headers: req.headers,
          body: Buffer.concat(chunks),
        };
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'set-cookie': ['session=one; HttpOnly; SameSite=Strict; Domain=localhost; Path=/'],
        });
        res.end(seen.body);
      })
    );
    const origin = await gateway(base);
    const bytes = Buffer.from([0, 255, 254, 128, 13, 10]);
    const response = await fetch(`${origin}/api/extensions/one/service/upload?name=test`, {
      method: 'PATCH',
      body: bytes,
      headers: {
        origin,
        authorization: 'Bearer host-secret',
        cookie: 'host=secret; xangi_ext_6f6e65_session=one; xangi_ext_74776f_session=two',
        'content-type': 'application/octet-stream',
      },
    });
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
    expect(seen.method).toBe('PATCH');
    expect(seen.url).toBe('/upload?name=test');
    expect(seen.headers.authorization).toBe('Bearer private-one');
    expect(seen.headers.cookie).toBe('session=one');
    expect(seen.headers.origin).toBe(base);
    expect(response.headers.get('set-cookie')).toBe(
      'xangi_ext_6f6e65_session=one; HttpOnly; SameSite=Strict; Path=/api/extensions/one/service/'
    );
    await fetch(`${origin}/api/extensions/two/service/`, {
      headers: { cookie: 'xangi_ext_6f6e65_session=one' },
    });
    expect(seen.headers.cookie).toBeUndefined();
  });
  it('streams events before upstream completion and closes upstream on disconnect', async () => {
    let close!: () => void;
    const closed = new Promise<void>((done) => {
      close = done;
    });
    const base = await listen(
      createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: first\n\n');
        res.on('close', close);
      })
    );
    const origin = await gateway(base);
    const abort = new AbortController();
    const response = await fetch(`${origin}/api/extensions/one/service/events`, {
      signal: abort.signal,
    });
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe('data: first\n\n');
    abort.abort();
    await closed;
  });
  it('rejects cross-origin HTTP without reaching the service and rewrites internal redirects', async () => {
    let requests = 0;
    const base = await listen(
      createServer((req, res) => {
        requests++;
        res.writeHead(302, {
          location: req.url === '/external' ? 'https://outside.example/' : '/next?ok=1',
        });
        res.end();
      })
    );
    const origin = await gateway(base);
    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(
        (
          await fetch(`${origin}/api/extensions/one/service/`, {
            method,
            headers: { origin: 'https://foreign.example' },
          })
        ).status
      ).toBe(403);
    }
    expect(requests).toBe(0);
    const response = await fetch(`${origin}/api/extensions/one/service/`, { redirect: 'manual' });
    expect(response.headers.get('location')).toBe('/api/extensions/one/service/next?ok=1');
    expect((await fetch(`${origin}/api/extensions/one/service/external`)).status).toBe(502);
  });
  it('proxies WebSocket traffic, scoped cookies, and closes both sockets', async () => {
    const server = createServer();
    const wss = new WebSocketServer({ server });
    cleanup.push(() => {
      for (const ws of wss.clients) ws.terminate();
      wss.close();
    });
    const base = await listen(server);
    const origin = await gateway(base);
    let seen: any;
    wss.on('connection', (ws, req) => {
      seen = req;
      ws.on('message', (data) => ws.send(data));
    });
    const ws = new WebSocket(
      `${origin.replace('http:', 'ws:')}/api/extensions/one/service/socket?q=1`,
      { origin, headers: { cookie: 'host=secret; xangi_ext_6f6e65_session=one' } }
    );
    cleanup.push(() => ws.terminate());
    await once(ws, 'open');
    const received = once(ws, 'message');
    ws.send('terminal input');
    expect(String((await received)[0])).toBe('terminal input');
    expect(seen.url).toBe('/socket?q=1');
    expect(seen.headers.cookie).toBe('session=one');
    expect(seen.headers.authorization).toBe('Bearer private-one');
    expect(seen.headers.origin).toBe(base);
    ws.close();
    await once(ws, 'close');
  });
  it('rejects cross-origin and missing-origin WebSocket handshakes', async () => {
    const base = await listen(createServer());
    const origin = await gateway(base);
    for (const clientOrigin of [undefined, 'https://foreign.example']) {
      const ws = new WebSocket(
        `${origin.replace('http:', 'ws:')}/api/extensions/one/service/socket`,
        { origin: clientOrigin }
      );
      const error = await new Promise<Error>((done) => ws.once('error', done));
      expect(error.message).toContain('403');
    }
  });
});

describe('extension device ingress', () => {
  it('accepts companion origins, preserves binary/query, separates device and runtime tokens', async () => {
    let seen: any;
    const base = await listen(
      createServer(async (req, res) => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk);
        seen = { url: req.url, headers: req.headers, body: Buffer.concat(chunks) };
        res.writeHead(
          req.headers['x-xangi-device-authorization'] === 'Bearer device-secret' ? 200 : 401,
          {
            'content-type': 'application/octet-stream',
            'set-cookie': 'private=value',
          }
        );
        res.end(seen.body);
      })
    );
    const origin = await gateway(base, true);
    const body = Buffer.from([0, 255, 128, 13]);
    const response = await fetch(`${origin}/api/devices/sample-watch/stt?format=pcm`, {
      method: 'POST',
      body,
      headers: {
        origin: 'https://companion.example',
        'sec-fetch-site': 'cross-site',
        authorization: 'Bearer device-secret',
        cookie: 'host=secret; xangi_ext_73616d706c652d7761746368_session=private',
        'x-xangi-device-authorization': 'Bearer forged',
      },
    });
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(body);
    expect(seen.url).toBe('/device/stt?format=pcm');
    expect(seen.headers.authorization).toBe('Bearer private-sample-watch');
    expect(seen.headers['x-xangi-device-authorization']).toBe('Bearer device-secret');
    expect(seen.headers.cookie).toBeUndefined();
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect((await fetch(`${origin}/api/devices/sample-watch/health`)).status).toBe(401);
    expect((await fetch(`${origin}/api/devices/other/health`)).status).toBe(502);
    expect(
      (await fetch(`${origin}/api/devices/sample-watch/health`, { method: 'DELETE' })).status
    ).toBe(405);
  });
  it('streams authenticated EventSource queries without buffering', async () => {
    let seen = '';
    const base = await listen(
      createServer((req, res) => {
        seen = req.url || '';
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: ready\n\n');
      })
    );
    const origin = await gateway(base, true);
    const abort = new AbortController();
    const response = await fetch(
      `${origin}/api/devices/sample-watch/terminal/events?token=event-secret`,
      { signal: abort.signal }
    );
    const chunk = await response.body!.getReader().read();
    expect(new TextDecoder().decode(chunk.value)).toBe('data: ready\n\n');
    expect(seen).toBe('/device/terminal/events?token=event-secret');
    abort.abort();
  });
});

import {
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'http';
import { request as httpsRequest } from 'https';
import type { Duplex } from 'stream';
import { acceptsSameHostMutation, sendJson } from './web-http.js';

type Target = { baseUrl: string; authorization: string };
type ResolveTarget = (id: string) => Promise<Target>;
const route = /^\/api\/extensions\/([a-zA-Z0-9._-]+)\/service(\/.*)$/;
const prefix = (id: string) => `xangi_ext_${Buffer.from(id).toString('hex')}_`;
const servicePath = (id: string) => `/api/extensions/${id}/service`;

function allowed(req: IncomingMessage, websocket = false): boolean {
  return (
    req.headers['sec-fetch-site'] !== 'cross-site' &&
    acceptsSameHostMutation(req) &&
    (!websocket || !!req.headers.origin)
  );
}

function headers(req: IncomingMessage, target: Target, id: string, websocket = false) {
  const result: Record<string, string> = {
    authorization: target.authorization,
    // The extension checks its own origin. The browser origin is checked above.
    origin: new URL(target.baseUrl).origin,
  };
  for (const name of [
    'content-type',
    'accept',
    'last-event-id',
    ...(websocket
      ? [
          'sec-websocket-key',
          'sec-websocket-version',
          'sec-websocket-protocol',
          'sec-websocket-extensions',
        ]
      : []),
  ]) {
    const value = req.headers[name];
    if (typeof value === 'string') result[name] = value;
  }
  const cookie = req.headers.cookie
    ?.split(/;\s*/)
    .filter((value) => value.startsWith(prefix(id)))
    .map((value) => value.slice(prefix(id).length))
    .join('; ');
  if (cookie) result.cookie = cookie;
  if (websocket) {
    result.connection = 'Upgrade';
    result.upgrade = 'websocket';
  }
  return result;
}

function responseHeaders(upstream: IncomingMessage, target: Target, id: string, path: string) {
  const result: Record<string, string | string[]> = {
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  };
  for (const name of [
    'content-type',
    'content-encoding',
    'content-disposition',
    'content-security-policy',
  ]) {
    const value = upstream.headers[name];
    if (value) result[name] = value;
  }
  if (upstream.headers['set-cookie']) {
    result['set-cookie'] = upstream.headers['set-cookie'].map((cookie) => {
      const [value, ...attributes] = cookie.split(';');
      // A different extension must never receive this session cookie, even if
      // both upstream services use the same cookie name or Path=/.
      return `${prefix(id)}${value}; ${attributes
        .filter((attribute) => !/^\s*(domain|path)\s*=/i.test(attribute))
        .map((attribute) => attribute.trim())
        .concat(`Path=${servicePath(id)}/`)
        .join('; ')}`;
    });
  }
  if (upstream.headers.location) {
    const location = new URL(upstream.headers.location, `${target.baseUrl}${path}`);
    if (location.origin !== new URL(target.baseUrl).origin)
      throw new Error('External extension redirect is not allowed');
    result.location = `${servicePath(id)}${location.pathname}${location.search}${location.hash}`;
  }
  return result;
}

async function requestBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > 32 * 1024 * 1024) throw new Error('Extension request body is too large');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

/** Streaming HTTP proxy. Only the registered extension's bearer token is sent upstream. */
export async function proxyExtensionRequest(
  req: IncomingMessage,
  res: ServerResponse,
  resolve: ResolveTarget
): Promise<boolean> {
  const match = (req.url || '').match(route);
  if (!match) return false;
  if (!allowed(req)) {
    sendJson(res, 403, { error: 'cross-origin extension requests are not allowed' });
    return true;
  }
  if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method || '')) {
    sendJson(res, 405, { error: 'method not allowed' });
    return true;
  }
  try {
    const [, id, path] = match;
    const target = await resolve(id);
    const body = ['GET', 'HEAD'].includes(req.method || '') ? undefined : await requestBody(req);
    if (res.destroyed) return true;
    const address = new URL(target.baseUrl);
    const upstream = (address.protocol === 'https:' ? httpsRequest : httpRequest)(address, {
      method: req.method,
      path: `${address.pathname.replace(/\/$/, '')}${path}`,
      headers: headers(req, target, id),
    });
    const fail = (error: Error) => {
      if (res.destroyed) return;
      if (res.headersSent) res.destroy(error);
      else sendJson(res, 502, { error: error.message });
    };
    // Timeout only until response headers: SSE and downloads may run longer.
    upstream.setTimeout(30_000, () => upstream.destroy(new Error('Extension response timed out')));
    upstream.on('error', fail);
    res.on('close', () => upstream.destroy());
    upstream.on('response', (response) => {
      upstream.setTimeout(0);
      try {
        res.writeHead(response.statusCode || 502, responseHeaders(response, target, id, path));
      } catch (error) {
        response.destroy();
        fail(error as Error);
        return;
      }
      response.on('error', fail);
      res.on('close', () => response.destroy());
      response.pipe(res);
    });
    upstream.end(body);
  } catch (error) {
    if (!res.destroyed)
      sendJson(res, 502, { error: error instanceof Error ? error.message : String(error) });
  }
  return true;
}

export function attachExtensionWebSockets(
  server: Server,
  resolve: ResolveTarget,
  enabled = true
): void {
  server.on('upgrade', (req, socket, head) => {
    const match = (req.url || '').match(route);
    const reject = (status: number) => {
      socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    };
    socket.on('error', () => {});
    if (!enabled || !match) {
      reject(404);
      return;
    }
    if (!allowed(req, true) || req.headers.upgrade?.toLowerCase() !== 'websocket') {
      reject(403);
      return;
    }
    void (async () => {
      const [, id, path] = match;
      const target = await resolve(id);
      if (socket.destroyed) return;
      const address = new URL(target.baseUrl);
      const upstream = (address.protocol === 'https:' ? httpsRequest : httpRequest)(address, {
        method: 'GET',
        path: `${address.pathname.replace(/\/$/, '')}${path}`,
        headers: headers(req, target, id, true),
      });
      let peer: Duplex | undefined;
      upstream.setTimeout(10_000, () =>
        upstream.destroy(new Error('Extension WebSocket timed out'))
      );
      upstream.on('error', () => {
        if (peer) socket.destroy();
        else reject(502);
      });
      socket.on('close', () => {
        upstream.destroy();
        peer?.destroy();
      });
      upstream.on('response', (response) => {
        response.resume();
        reject(response.statusCode || 502);
      });
      upstream.on('upgrade', (response, connected, upstreamHead) => {
        peer = connected;
        upstream.setTimeout(0);
        if (socket.destroyed) {
          connected.destroy();
          return;
        }
        const responseLines = [
          'HTTP/1.1 101 Switching Protocols',
          'Connection: Upgrade',
          'Upgrade: websocket',
        ];
        for (const name of [
          'sec-websocket-accept',
          'sec-websocket-protocol',
          'sec-websocket-extensions',
        ]) {
          const value = response.headers[name];
          if (value) responseLines.push(`${name}: ${value}`);
        }
        socket.write(responseLines.join('\r\n') + '\r\n\r\n');
        if (upstreamHead.length) socket.write(upstreamHead);
        if (head.length) connected.write(head);
        connected.on('error', () => socket.destroy());
        connected.on('close', () => socket.destroy());
        socket.pipe(connected).pipe(socket);
      });
      upstream.end();
    })().catch(() => reject(502));
  });
}

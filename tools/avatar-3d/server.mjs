import { createServer, request } from 'node:http';
import { createReadStream, readFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(root, 'public');
const threeDir = resolve(root, 'node_modules/three');
const importMap = readFileSync(resolve(publicDir, 'index.html'), 'utf8').match(/<script type="importmap">([\s\S]*?)<\/script>/)[1];
const hash = createHash('sha256').update(importMap).digest('base64');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.vrm': 'application/octet-stream', '.ico': 'image/x-icon' };
const connections = new WeakMap();

export function closePreviewServer(server) {
  for (const socket of connections.get(server) || []) socket.destroy();
  return new Promise(done => server.close(done));
}

export function createPreviewServer({ shellUrl, runtimeRoot } = {}) {
  const upstream = shellUrl ? new URL(shellUrl) : null;
  if (upstream && (upstream.protocol !== 'http:' || upstream.hostname !== '127.0.0.1' || upstream.username || upstream.password || upstream.pathname !== '/')) throw new Error('Shell must be an explicit loopback HTTP origin');
  let speechSource;
  if (upstream) {
    if (!runtimeRoot) throw new Error('Live mode requires the canonical LG runtime root');
    const source = readFileSync(resolve(runtimeRoot, 'scripts/postlv2_speech_client.js'), 'utf8');
    const tail = '\nexport const speechPlayback =';
    if (source.split(tail).length !== 2 || !source.includes('export function createSpeechPlayback(')) throw new Error('Unrecognized LG speech adapter source');
    speechSource = source.split(tail)[0].replace(/^import \{ expressionPlayback \} from .*;\r?\n/m, '');
  }
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'self' 'sha256-${hash}'; style-src 'self'; connect-src 'self' blob:; img-src 'self' blob: data:; media-src 'self' blob:; base-uri 'none'; frame-ancestors 'none'`);
    const route = new URL(req.url, 'http://localhost').pathname;
    if (route === '/session.json' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ live: !!upstream, speechSourceSha256: speechSource ? createHash('sha256').update(speechSource).digest('hex') : null })); return;
    }
    if (upstream && route === '/lg-adapter/speech.js' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': types['.js'] }).end(speechSource); return;
    }
    if (upstream && ['/lg/status', '/lg/playback', '/lg/interrupt', '/lg/client-timing'].includes(route) && ['GET', 'POST'].includes(req.method)) {
      if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) { res.writeHead(403).end(); return; }
      const proxy = request(new URL(route, upstream), { method: req.method, headers: { 'content-type': req.headers['content-type'] || 'application/json' }, timeout: 15000 }, reply => {
        res.writeHead(reply.statusCode, { 'Content-Type': reply.headers['content-type'] || 'application/json' }); reply.pipe(res);
      });
      proxy.on('timeout', () => proxy.destroy());
      proxy.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      req.pipe(proxy); return;
    }
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405).end(); return; }
    try {
      const path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      let file;
      if (path === '/vendor/vrm.js') file = resolve(root, 'node_modules/@pixiv/three-vrm/lib/three-vrm.module.min.js');
      else {
        const base = path.startsWith('/vendor/three/') ? threeDir : publicDir;
        const relative = base === threeDir ? path.slice('/vendor/three/'.length) : path === '/' ? 'index.html' : path.slice(1);
        file = resolve(base, relative);
        if (!file.startsWith(base + sep)) { res.writeHead(403).end(); return; }
      }
      const info = await stat(file);
      if (!info.isFile()) { res.writeHead(404).end(); return; }
      res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream', 'Content-Length': info.size });
      if (req.method === 'HEAD') res.end();
      else createReadStream(file).on('error', () => res.destroy()).pipe(res);
    } catch { res.writeHead(404).end(); }
  });
  const sockets = new Set(); connections.set(server, sockets);
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.on('upgrade', (req, socket, head) => {
    if (!upstream || req.url !== '/client-ws' || req.headers.origin !== `http://${req.headers.host}`) { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
    const proxy = request(new URL('/client-ws', upstream), { headers: { ...req.headers, host: upstream.host } });
    proxy.on('upgrade', (reply, peer, extra) => {
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${reply.rawHeaders.reduce((s, value, i) => s + (i % 2 ? `${value}\r\n` : `${value}: `), '')}\r\n`);
      if (head.length) peer.write(head); if (extra.length) socket.write(extra);
      peer.on('error', () => socket.destroy()); socket.on('error', () => peer.destroy());
      socket.on('close', () => peer.destroy()); peer.on('close', () => socket.destroy());
      socket.pipe(peer); peer.pipe(socket);
    });
    proxy.on('response', () => socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'));
    proxy.on('error', () => socket.destroy()); proxy.end();
  });
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const server = createPreviewServer({ shellUrl: args.includes('--shell-url') ? args[args.indexOf('--shell-url') + 1] : undefined,
    runtimeRoot: args.includes('--runtime-root') ? args[args.indexOf('--runtime-root') + 1] : undefined });
  server.on('error', error => { console.error(error.message); process.exitCode = 1; });
  server.listen(12403, '127.0.0.1', () => console.log(`3D avatar: http://127.0.0.1:12403 (${args.includes('--shell-url') ? 'explicit LG shell connection' : 'preview only'})`));
  process.once('SIGINT', () => void closePreviewServer(server));
  process.once('SIGTERM', () => void closePreviewServer(server));
}

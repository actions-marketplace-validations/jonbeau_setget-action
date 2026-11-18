// A small mock of the SetGet API for tests. Routes are matched as "METHOD /path" (query ignored).
// Each handler gets (req, res, body, url) and may use the helpers below. Every request is recorded.
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'setget.js');

export function send(res, status, body, headers = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': typeof body === 'string' ? 'text/plain' : 'application/json', ...headers });
  res.end(status === 304 ? undefined : text);
}

export function apiError(res, status, code, message, fix, extra = {}, headers = {}) {
  send(res, status, { error: { code, message, fix, ...extra } }, headers);
}

export function sse(res, events) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write('retry: 2000\n\n');
  for (const e of events) res.write((e.id != null ? `id: ${e.id}\n` : '') + `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`);
  res.end();
}

export async function startMock(routes) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const url = new URL(req.url, 'http://x');
    const rec = { method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body: body.toString('utf8') };
    requests.push(rec);
    const handler = routes[`${req.method} ${url.pathname}`] || Object.entries(routes).find(([k]) => {
      const [m, p] = k.split(' ');
      return m === req.method && p.includes('*') && new RegExp('^' + p.replace(/\*/g, '[^/]+') + '$').test(url.pathname);
    })?.[1];
    if (!handler) return apiError(res, 404, 'not_found', `No mock for ${req.method} ${url.pathname}.`, '');
    try { await handler(req, res, rec, url); } catch (err) { send(res, 500, { error: { code: 'mock', message: String(err) } }); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, requests, close: () => new Promise((r) => server.close(r)) };
}

// Run the CLI as a child process (async, so the in-process mock keeps serving).
export function cli(args, { base, env = {}, input } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      env: { ...process.env, SETGET_URL: base || '', SETGET_TOKEN: '', SETGET_DEBUG: '', ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    if (input !== undefined) child.stdin.end(input); else child.stdin.end();
  });
}

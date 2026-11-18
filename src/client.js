// SetGet HTTP client: requests, the error envelope, Server-Sent Events and file uploads.
// Zero dependencies: built-in fetch for JSON calls, node:http(s) for uploads so progress is real.
// The same file is copied into clients/github-action/src/client.js; keep the two identical.
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';

export const DEFAULT_BASE = 'https://setget.net';

export class ApiError extends Error {
  constructor({ status = 0, code = 'error', message = 'The request failed.', fix = '', problems = [], suggestions = [],
                retryAfter = null, jobId = null } = {}) {
    super(message);
    Object.assign(this, { status, code, fix, problems, suggestions, retryAfter, jobId });
  }
}

// Turn any error body into an ApiError. Handles the v1 envelope, legacy {"error": "..."} and plain text.
export function toApiError(status, text, headers) {
  let body = null;
  try { body = JSON.parse(text); } catch { /* not JSON */ }
  const e = body && typeof body.error === 'object' && body.error ? body.error
    : { message: body && typeof body.error === 'string' ? body.error : (text || '').trim().slice(0, 300) };
  const ra = headers && headers.get ? headers.get('retry-after') : null;
  const retryAfter = ra != null && ra !== '' && Number.isFinite(Number(ra)) ? Number(ra) : null;
  return new ApiError({ status, code: e.code || `http_${status}`, message: e.message || `The server answered ${status}.`,
    fix: e.fix || '', problems: Array.isArray(e.problems) ? e.problems : [], suggestions: e.suggestions || [],
    retryAfter, jobId: (e.job && e.job.id) || (body && body.job && body.job.id) || null });
}

function networkError(base, err) {
  const why = (err && err.cause && (err.cause.code || err.cause.message)) || (err && err.message) || 'unknown error';
  return new ApiError({ code: 'network', message: `Could not reach ${base} (${why}).`,
    fix: 'Check the address (--base or SETGET_URL) and your network connection, then try again.' });
}

export function createClient({ base = DEFAULT_BASE, token = '', userAgent = 'setget-cli' } = {}) {
  base = String(base || DEFAULT_BASE).replace(/\/+$/, '');
  const auth = token ? { authorization: `Bearer ${token}` } : {};

  function url(p, query) {
    const u = new URL(/^https?:/.test(p) ? p : base + p);
    for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
    return u.toString();
  }

  async function request(method, p, { json, body, headers = {}, query, ok = [], signal } = {}) {
    const h = { 'user-agent': userAgent, accept: 'application/json', ...auth, ...headers };
    if (json !== undefined) { h['content-type'] = 'application/json'; body = JSON.stringify(json); }
    let res;
    try { res = await fetch(url(p, query), { method, headers: h, body, signal }); }
    catch (err) { if (err && err.name === 'AbortError') throw err; throw networkError(base, err); }
    const text = method === 'HEAD' ? '' : await res.text();
    if (!res.ok && !ok.includes(res.status)) throw toApiError(res.status, text, res.headers);
    let data = null;
    if (text && (res.headers.get('content-type') || '').includes('json')) { try { data = JSON.parse(text); } catch { /* raw */ } }
    return { status: res.status, headers: res.headers, text, data };
  }

  // Follow a Server-Sent Events stream until an `end` event. Reconnects with Last-Event-ID when the server
  // closes the stream early (it does after five minutes). Returns the `end` event's data.
  async function follow(p, onEvent = () => {}, { maxReconnects = 20 } = {}) {
    let last = null;
    for (let attempt = 0; attempt <= maxReconnects; attempt++) {
      const h = { 'user-agent': userAgent, accept: 'text/event-stream', ...auth };
      if (last != null) h['last-event-id'] = String(last);
      let res;
      try { res = await fetch(url(p), { headers: h }); } catch (err) { throw networkError(base, err); }
      if (!res.ok) throw toApiError(res.status, await res.text(), res.headers);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n?/g, '\n');
        let cut;
        while ((cut = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, cut); buffer = buffer.slice(cut + 2);
          const ev = parseEvent(block);
          if (!ev) continue;
          if (ev.id != null) last = ev.id;
          if (ev.event === 'end') { try { await reader.cancel(); } catch { /* closed */ } return ev.data; }
          onEvent(ev);
        }
      }
    }
    throw new ApiError({ code: 'stream_closed', message: 'The progress stream kept closing before the work finished.',
      fix: 'Check the status later with GET ' + p.replace(/\/events$/, '') });
  }

  // PUT a local file to an upload URL with exact headers. Progress counts bytes handed to the socket.
  function putFile(target, file, headers = {}, onProgress = () => {}) {
    const size = fs.statSync(file).size;
    const u = new URL(target);
    const lib = u.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
      const req = lib.request(u, { method: 'PUT', headers: { 'user-agent': userAgent, ...headers, 'content-length': size } }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { text += c; });
        res.on('end', () => (res.statusCode >= 200 && res.statusCode < 300 ? resolve({ status: res.statusCode, text })
          : reject(toApiError(res.statusCode, text, { get: (k) => res.headers[k.toLowerCase()] }))));
      });
      req.on('error', (err) => reject(networkError(base, err)));
      let sent = 0;
      onProgress(0, size);
      const stream = fs.createReadStream(file, { highWaterMark: 64 * 1024 });
      stream.on('data', (chunk) => {
        if (!req.write(chunk)) { stream.pause(); req.once('drain', () => stream.resume()); }
        sent += chunk.length; onProgress(sent, size);
      });
      stream.on('error', reject);
      stream.on('end', () => req.end());
    });
  }

  // Upload local files into one new drop. Returns the drop with every file ready (ref, url).
  async function upload(files, { ttl, onProgress = () => {} } = {}) {
    const entries = files.map((f) => {
      let st;
      try { st = fs.statSync(f); } catch { throw new ApiError({ code: 'no_such_file', message: `There is no file at ${f}.`, fix: 'Check the path.' }); }
      if (!st.isFile()) throw new ApiError({ code: 'not_a_file', message: `${f} is not a file.`, fix: 'Give the path of a file, not a folder.' });
      return { name: path.basename(f), size: st.size };
    });
    const body = { files: entries };
    if (ttl) body.ttl_seconds = Number(ttl);
    const { data: drop } = await request('POST', '/v1/drops', { json: body });
    const ready = [];
    for (let i = 0; i < files.length; i++) {
      const spec = drop.files[i];
      await putFile(spec.upload.url, files[i], spec.upload.headers || {}, (sent, total) => onProgress({ index: i, name: spec.name, sent, total }));
      const { data } = await request('POST', `/v1/drops/${drop.id}/files/${spec.id}/complete`, { json: {} });
      ready.push(data || spec);
    }
    return { ...drop, files: ready };
  }

  // Download a URL to a file in dir. Returns the written path.
  async function download(fileUrl, dir, name) {
    let res;
    try { res = await fetch(fileUrl, { headers: { 'user-agent': userAgent } }); } catch (err) { throw networkError(base, err); }
    if (!res.ok) throw toApiError(res.status, await res.text(), res.headers);
    fs.mkdirSync(dir, { recursive: true });
    const out = path.join(dir, path.basename(name || new URL(fileUrl).pathname));
    fs.writeFileSync(out, Buffer.from(await res.arrayBuffer()));
    return out;
  }

  return { base, url, request, follow, putFile, upload, download };
}

export function parseEvent(block) {
  const ev = { event: 'message', data: '', id: null };
  let any = false;
  for (const line of block.split('\n')) {
    if (!line || line.startsWith(':')) continue;
    const i = line.indexOf(':');
    const field = i < 0 ? line : line.slice(0, i);
    const value = i < 0 ? '' : line.slice(i + 1).replace(/^ /, '');
    if (field === 'event') { ev.event = value; any = true; }
    else if (field === 'data') { ev.data += (ev.data ? '\n' : '') + value; any = true; }
    else if (field === 'id') ev.id = value;
  }
  if (!any) return null;
  try { ev.data = JSON.parse(ev.data); } catch { /* keep text */ }
  return ev;
}

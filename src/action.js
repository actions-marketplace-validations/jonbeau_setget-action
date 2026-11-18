// SetGet GitHub Action. Zero dependencies: reads INPUT_* variables, writes $GITHUB_OUTPUT, logs with workflow commands.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ApiError, createClient } from './client.js';

export function getInput(name, env = process.env) {
  const v = env[`INPUT_${name.replace(/ /g, '_').toUpperCase()}`];
  return v == null ? '' : v.trim();
}

function setOutput(name, value, env) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const file = env.GITHUB_OUTPUT;
  if (file) {
    const delim = `ghadelim_${crypto.randomUUID()}`;
    fs.appendFileSync(file, `${name}<<${delim}\n${text}\n${delim}\n`);
  } else {
    process.stdout.write(`${name}=${text}\n`);
  }
}

const escapeData = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');

export function errorText(err) {
  const parts = [err.message + (err.code ? ` (${err.code})` : '')];
  for (const p of err.problems || []) parts.push(`${p.field ? p.field + ': ' : ''}${p.message}`);
  if (err.status === 429) parts.push(err.retryAfter != null ? `Rate limited: retry after ${err.retryAfter} seconds.` : 'Rate limited.');
  if (err.fix) parts.push(`Fix: ${err.fix}`);
  if (err.jobId) parts.push(`Job: ${err.jobId}`);
  return parts.join('\n');
}

function parseFiles(text, workspace) {
  return text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((line) => {
    const m = /^([A-Za-z_][\w-]*)=(.+)$/.exec(line);
    const [name, file] = m ? [m[1], m[2].trim()] : [null, line];
    return { name, file: path.resolve(workspace, file) };
  });
}

export async function run({ env = process.env, log = (s) => process.stdout.write(s + '\n') } = {}) {
  const input = (n) => getInput(n, env);
  const client = createClient({ base: input('base-url') || 'https://setget.net', token: input('token'), userAgent: 'setget-github-action/0.1.0' });
  const token = input('token');
  if (token) log(`::add-mask::${token}`);
  const ttl = input('ttl') ? Number(input('ttl')) : undefined;
  if (ttl !== undefined && !(Number.isInteger(ttl) && ttl > 0)) throw new ApiError({ code: 'bad_input', message: '`ttl` must be a whole number of seconds.', fix: 'For example ttl: 3600' });

  if (input('badge-key')) {
    const key = input('badge-key');
    await client.request('PUT', `/v1/keys/${encodeURIComponent(key)}`, { body: input('value'), query: { ttl_seconds: ttl },
      headers: { 'content-type': 'text/plain; charset=utf-8' } });
    const q = new URLSearchParams({ label: input('badge-label') || 'value' });
    const color = input('badge-color');
    if (color) q.set(color.includes(':') ? 'thresholds' : 'color', color);
    const url = `${client.base}/badge/${encodeURIComponent(key)}?${q}`;
    log(`Badge ${key} = ${input('value')}\n${url}`);
    setOutput('badge-url', url, env);
    setOutput('result', JSON.stringify(input('value')), env);
    return;
  }
  if (input('set-key')) {
    const key = input('set-key');
    const { data } = await client.request('PUT', `/v1/keys/${encodeURIComponent(key)}`, { body: input('value'), query: { ttl_seconds: ttl },
      headers: { 'content-type': 'text/plain; charset=utf-8' } });
    log(`Stored ${key} (${data ? data.size_bytes : 0} bytes)`);
    setOutput('result', data || {}, env);
    return;
  }
  if (input('get-key')) {
    const key = input('get-key');
    const res = await client.request('GET', `/v1/keys/${encodeURIComponent(key)}`, { query: { format: 'raw' } });
    log(`Read ${key} (${Buffer.byteLength(res.text)} bytes)`);
    setOutput('result', res.text, env);
    return;
  }

  const slug = input('tool');
  if (!slug) throw new ApiError({ code: 'bad_input', message: 'Nothing to do: set `tool`, `set-key`, `get-key` or `badge-key`.', fix: 'See https://setget.net/tools for tool names.' });
  let toolInput;
  try { toolInput = JSON.parse(input('input') || '{}'); } catch { throw new ApiError({ code: 'bad_input', message: '`input` is not valid JSON.', fix: 'Write it as a JSON object, for example {"width": 320}.' }); }
  const info = (await client.request('GET', `/v1/tools/${encodeURIComponent(slug)}`)).data;
  const files = parseFiles(input('files'), env.GITHUB_WORKSPACE || process.cwd());
  if (files.length) {
    const firstFileInput = Object.entries((info.input_schema || {}).properties || {}).find(([, p]) => p.format === 'setget-file')?.[0];
    let last = -1;
    const drop = await client.upload(files.map((f) => f.file), { ttl, onProgress: ({ name, sent, total }) => {
      const q = total ? Math.floor((sent / total) * 4) : 4;
      if (q !== last) { last = q; log(`upload ${name}: ${q * 25}%`); }
    } });
    files.forEach((f, i) => {
      const name = f.name || firstFileInput;
      if (!name) throw new ApiError({ code: 'bad_input', message: `${slug} takes no file input, so "${path.basename(f.file)}" needs a name.`, fix: 'Write the line as name=path.' });
      toolInput[name] = drop.files[i].ref;
    });
  }
  const wait = input('wait') !== 'false';
  const body = { input: toolInput };
  if (info.tier === 'job') { body.wait = 0; if (ttl) body.ttl_seconds = ttl; }
  const res = await client.request('POST', `/v1/tools/${encodeURIComponent(slug)}`, { json: body });
  let out = res.data;
  if (out.job) { setOutput('job-id', out.job.id, env); log(`Job ${out.job.id}: ${out.job.url}`); }
  if (out.job && out.result === undefined) {
    if (!wait) { log('Not waiting for the job (wait: false).'); return; }
    log('::group::Progress');
    let end;
    try {
      end = await client.follow(out.job.events_url || `/v1/jobs/${out.job.id}/events`, (ev) => {
        if (ev.event !== 'progress' || !ev.data) return;
        const d = ev.data;
        log(`${d.percent == null ? '   -' : String(Math.round(d.percent)).padStart(3) + '%'} ${d.stage}: ${d.message || ''}`);
      });
    } finally { log('::endgroup::'); }
    if (end.status !== 'done') {
      const e = end.error || {};
      throw new ApiError({ code: e.code || end.status, message: e.message || `The job ended as ${end.status}.`, fix: e.fix || '', problems: e.problems || [], jobId: end.id });
    }
    out = { result: end.result, files: end.files || [] };
  }
  const dir = input('output-dir');
  const listed = [];
  for (const f of out.files || []) {
    const item = { name: f.name, size: f.size, ref: f.ref, url: f.url };
    if (dir) { item.path = await client.download(f.download || f.url, path.resolve(env.GITHUB_WORKSPACE || process.cwd(), dir), f.name); log(`Saved ${item.path}`); }
    else log(`Result file ${f.name}: ${f.url}`);
    listed.push(item);
  }
  setOutput('result', out.result === undefined ? null : out.result, env);
  setOutput('files', listed, env);
}

export async function main(env = process.env) {
  try { await run({ env }); return 0; }
  catch (err) {
    const text = err instanceof ApiError ? errorText(err) : (err && err.message) || String(err);
    process.stdout.write(`::error title=SetGet::${escapeData(text)}\n`);
    if (env.SETGET_DEBUG === '1' && err && err.stack) process.stdout.write(err.stack + '\n');
    return 1;
  }
}

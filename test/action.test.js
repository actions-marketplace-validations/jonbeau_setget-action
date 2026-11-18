import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { apiError, send, sse, startMock } from '../support/mock.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.join(here, '..', 'src', 'index.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'setget-action-'));
fs.writeFileSync(path.join(tmp, 'shot.png'), Buffer.alloc(1000, 1));
const keys = new Map();
let mock;

before(async () => {
  mock = await startMock({
    'PUT /v1/keys/*': (req, res, r) => { keys.set(r.path.split('/')[3], r.body); send(res, 201, { id: r.path.split('/')[3], size_bytes: Buffer.byteLength(r.body) }); },
    'GET /v1/keys/*': (req, res, r) => (keys.has(r.path.split('/')[3]) ? send(res, 200, keys.get(r.path.split('/')[3]))
      : apiError(res, 404, 'not_found', 'Key not found.')),
    'GET /v1/tools/*': (req, res, r) => {
      const slug = r.path.split('/')[3];
      if (slug === 'image-convert') return send(res, 200, { slug, tier: 'job', input_schema: { properties: { image: { format: 'setget-file' }, format: { type: 'string' } } } });
      if (slug === 'base64') return send(res, 200, { slug, tier: 'inline', input_schema: { properties: { text: { type: 'string' } } } });
      apiError(res, 404, 'unknown_tool', 'There is no tool named "x".', 'Check the spelling.');
    },
    'POST /v1/tools/base64': (req, res, r) => {
      const input = JSON.parse(r.body).input;
      if (!input.text) return apiError(res, 400, 'invalid_input', '"text" is required.', 'Fix the fields listed under "problems".', { problems: [{ field: 'text', message: '"text" is required.' }] });
      send(res, 200, { tool: 'base64', result: { text: Buffer.from(input.text).toString('base64') } });
    },
    'POST /v1/drops': (req, res, r) => send(res, 201, { id: 'D1', files: JSON.parse(r.body).files.map((f, i) => ({ id: `f${i + 1}`, name: f.name, ref: `D1/f${i + 1}`,
      upload: { url: `${mock.base}/up/f${i + 1}`, headers: { 'Content-Type': 'image/png' } } })) }),
    'PUT /up/*': (req, res) => { res.writeHead(200); res.end(); },
    'POST /v1/drops/D1/files/*/complete': (req, res, r) => send(res, 200, { id: r.path.split('/')[5], ref: `D1/${r.path.split('/')[5]}`, state: 'ready' }),
    'POST /v1/tools/image-convert': (req, res) => send(res, 202, { job: { id: 'J1', url: `${mock.base}/v/J1`, events_url: `${mock.base}/v1/jobs/J1/events` } }),
    'GET /v1/jobs/J1/events': (req, res) => sse(res, [
      { id: 1, event: 'progress', data: { stage: 'working', percent: 50, message: 'Converting.' } },
      { event: 'end', data: { id: 'J1', status: 'done', result: { format: 'webp' }, files: [{ name: 'shot.webp', size: 4, ref: 'J1/f1', url: `${mock.base}/files/z/shot.webp` }] } }]),
    'GET /files/z/shot.webp': (req, res) => { res.writeHead(200); res.end('WEBP'); },
  });
});
after(() => mock.close());

function action(inputs) {
  const out = path.join(tmp, `out-${Math.random().toString(36).slice(2)}.txt`);
  fs.writeFileSync(out, '');
  const env = { ...process.env, GITHUB_OUTPUT: out, GITHUB_WORKSPACE: tmp, 'INPUT_BASE-URL': mock.base };
  for (const [k, v] of Object.entries(inputs)) env[`INPUT_${k.toUpperCase()}`] = v;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [ENTRY], { env });
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stdout += d; });
    child.on('close', (code) => {
      const outputs = {};
      const re = /^([\w-]+)<<(ghadelim_[\w-]+)\n([\s\S]*?)\n\2\n/gm;
      for (const m of fs.readFileSync(out, 'utf8').matchAll(re)) outputs[m[1]] = m[3];
      resolve({ code, stdout, outputs });
    });
  });
}

test('text tool: result output', async () => {
  const r = await action({ tool: 'base64', input: '{"text":"hi"}' });
  assert.equal(r.code, 0, r.stdout);
  assert.deepEqual(JSON.parse(r.outputs.result), { text: 'aGk=' });
  assert.equal(r.outputs.files, '[]');
});

test('file tool: upload, progress lines in a group, download, outputs', async () => {
  const r = await action({ tool: 'image-convert', input: '{"format":"webp"}', files: 'shot.png', 'output-dir': 'out' });
  assert.equal(r.code, 0, r.stdout);
  assert.match(r.stdout, /upload shot\.png: 0%/); assert.match(r.stdout, /upload shot\.png: 100%/);
  assert.match(r.stdout, /::group::Progress\n 50% working: Converting\.\n::endgroup::/);
  const body = JSON.parse(mock.requests.findLast((q) => q.path === '/v1/tools/image-convert').body);
  assert.deepEqual(body, { input: { format: 'webp', image: 'D1/f1' }, wait: 0 });
  assert.equal(r.outputs['job-id'], 'J1');
  const files = JSON.parse(r.outputs.files);
  assert.equal(files[0].ref, 'J1/f1');
  assert.equal(fs.readFileSync(files[0].path, 'utf8'), 'WEBP');
});

test('wait: false only starts the job', async () => {
  const r = await action({ tool: 'image-convert', files: 'image=shot.png', wait: 'false' });
  assert.equal(r.code, 0, r.stdout);
  assert.equal(r.outputs['job-id'], 'J1'); assert.equal(r.outputs.result, undefined);
});

test('set-key, get-key and badge modes; token is masked and sent as Bearer', async () => {
  let r = await action({ 'set-key': 'k1', value: 'hello', token: 'sekrit' });
  assert.equal(r.code, 0, r.stdout);
  assert.match(r.stdout, /::add-mask::sekrit/);
  assert.equal(mock.requests.at(-1).headers.authorization, 'Bearer sekrit');
  r = await action({ 'get-key': 'k1' });
  assert.equal(r.outputs.result, 'hello');
  r = await action({ 'badge-key': 'tests-x', value: '128 passed', 'badge-label': 'tests', 'badge-color': 'brightgreen' });
  assert.equal(r.code, 0);
  assert.equal(r.outputs['badge-url'], `${mock.base}/badge/tests-x?label=tests&color=brightgreen`);
  assert.equal(keys.get('tests-x'), '128 passed');
  r = await action({ 'badge-key': 'cov', value: '91', 'badge-color': '0:red,80:brightgreen' });
  assert.match(r.outputs['badge-url'], /thresholds=0%3Ared%2C80%3Abrightgreen/);
});

test('errors print message and fix as ::error:: and fail the step', async () => {
  let r = await action({ tool: 'base64', input: '{}' });
  assert.equal(r.code, 1);
  assert.match(r.stdout, /::error title=SetGet::"text" is required\. \(invalid_input\)%0Atext: "text" is required\.%0AFix: Fix the fields/);
  r = await action({ tool: 'nope' });
  assert.equal(r.code, 1); assert.match(r.stdout, /unknown_tool/);
  r = await action({ tool: 'base64', input: '{bad' });
  assert.equal(r.code, 1); assert.match(r.stdout, /`input` is not valid JSON/);
  r = await action({});
  assert.equal(r.code, 1); assert.match(r.stdout, /Nothing to do/);
  r = await action({ 'get-key': 'missing' });
  assert.equal(r.code, 1); assert.match(r.stdout, /::error title=SetGet::Key not found\. \(not_found\)/);
  assert.doesNotMatch(r.stdout, /at .*\.js:\d+/);
});

test('client.js is the same file as the CLI copy', () => {
  const a = fs.readFileSync(path.join(here, '..', 'src', 'client.js'), 'utf8');
  const cli = path.join(here, '..', '..', 'cli', 'lib', 'client.js');
  if (!fs.existsSync(cli)) return; // published on its own
  assert.equal(a, fs.readFileSync(cli, 'utf8'));
});

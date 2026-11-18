# SetGet GitHub Action

Run [SetGet](https://setget.net) tools from a workflow: convert, resize and compress images, turn videos into GIFs, convert documents, run text and data tools, pass values between jobs and workflows, and keep a README badge up to date. No account and no API key.

The action is plain JavaScript on Node 20 with no dependencies and no build step.

## Inputs

| Input | Meaning |
| --- | --- |
| `tool` | Tool to run, for example `image-resize`, `video-to-gif`, `base64`. Browse them at <https://setget.net/tools>. |
| `input` | Tool input as a JSON object, for example `{"width": 320}`. Default `{}`. |
| `files` | Files to upload and pass to the tool, one per line, as `name=path` (paths are relative to the workspace). A line with only a path goes to the tool's first file input. |
| `wait` | `true` (default) follows a file-tool job to the end and logs its progress. `false` only starts it and outputs `job-id`. |
| `output-dir` | Folder to save result files into. Leave empty to only output their URLs. |
| `set-key` + `value` | Store `value` under a key. |
| `get-key` | Read a key into the `result` output (raw text). |
| `badge-key` + `value` | Store `value` under a public key and output `badge-url` that shows it. `badge-label` (default `value`) and `badge-color` (a colour such as `brightgreen`, or thresholds such as `0:red,80:brightgreen`). |
| `ttl` | Lifetime in seconds for a key or for uploaded files. |
| `token` | Optional key password or capability token. Pass it from a secret; it is masked in the log. |
| `base-url` | Server. Default `https://setget.net`. |

## Outputs

| Output | Meaning |
| --- | --- |
| `result` | The tool result as JSON, or the key's value (get mode). |
| `files` | JSON array of result files: `{name, size, ref, url, path}` (`path` when `output-dir` is set). |
| `job-id` | The job ID for file tools. |
| `badge-url` | The badge URL (badge mode). |

Progress from the job's live event stream is written to the log in a collapsible "Progress" group, one line per step (`10% working: Opened the image.`). When the server reports an error, the step fails with an `::error::` annotation that shows the message, each problem, and what to do about it.

## Examples

Replace `jonbeau/setget-action@v1` with where the action is published.

### Convert a screenshot to WebP and keep it as an artifact

```yaml
name: screenshot
on: [push]
jobs:
  convert:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - id: webp
        uses: jonbeau/setget-action@v1
        with:
          tool: image-resize
          files: image=docs/screenshot.png
          input: '{"width": 1200, "format": "webp"}'
          output-dir: out
      - run: echo '${{ steps.webp.outputs.result }}'
      - uses: actions/upload-artifact@v4
        with:
          name: screenshot
          path: out/
```

### Publish a test-count badge

```yaml
name: tests
on:
  push:
    branches: [main]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci && npm test -- --reporter=tap | tee tap.txt
      - id: count
        run: echo "passed=$(grep -c '^ok ' tap.txt)" >> "$GITHUB_OUTPUT"
      - uses: jonbeau/setget-action@v1
        with:
          badge-key: myproject-tests-7f3c2a          # pick a long, unguessable name
          value: ${{ steps.count.outputs.passed }} passed
          badge-label: tests
          badge-color: brightgreen
```

Then put the badge in your README:

```markdown
![tests](https://setget.net/badge/myproject-tests-7f3c2a?label=tests&color=brightgreen)
```

Badges can only show public keys, so anyone who knows the key name can also change it. Use a long random name, and do not put anything private in a badge.

### Pass a value between workflows

```yaml
      - uses: jonbeau/setget-action@v1
        with:
          set-key: myproject-last-deploy-91be
          value: ${{ github.sha }}
          ttl: 604800
```

```yaml
      - id: last
        uses: jonbeau/setget-action@v1
        with:
          get-key: myproject-last-deploy-91be
      - run: echo "Last deploy was ${{ steps.last.outputs.result }}"
```

## Limits and privacy

SetGet is free and shared, with per-IP limits; GitHub-hosted runners share IP ranges, so heavy use may hit them (the error says when to retry). Uploaded files and results can be read by anyone with the link and are deleted when they expire (one hour by default, at most one day). Do not upload secrets or personal data. Details: <https://setget.net/docs> and <https://setget.net/legal>.

## Development

```sh
npm test    # node --test against a mock server
# run locally against a server of your choice:
env INPUT_TOOL=base64 INPUT_INPUT='{"text":"hi"}' 'INPUT_BASE-URL=http://127.0.0.1:8080' node src/index.js
```

`src/client.js` is a copy of `clients/cli/lib/client.js`; a test checks the two stay identical.

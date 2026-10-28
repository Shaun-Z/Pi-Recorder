# Pi-Recorder

A local trace recorder for the Pi coding agent. Automatically capture turn-level debugging data and explore a live timeline of **sessions → tasks → turns → model and tool execution**.

Compatibility baseline: **Pi 1.4.0 and Node.js ≥ 22.19.0**. Pi loads the TypeScript extension directly; no build step is required.

## Quick start

Clone the repository and install the development and standalone viewer dependencies:

```sh
git clone https://github.com/Shaun-Z/Pi-Recorder.git
cd Pi-Recorder
npm install
```

Start Pi from the **project you want to record**, passing the absolute path to this extension:

```sh
cd /path/to/your-project
pi -e /path/to/Pi-Recorder/src/index.ts
```

After the `DEV extension loaded` notification appears and the status bar indicates that recording is active, submit tasks as usual. Run these commands inside Pi:

```text
/looplog
/looplog status
```

`/looplog` starts the local viewer and tries to open your default browser. If the browser cannot be opened, Pi prints a URL you can open manually. `/looplog status` reports the recorder status, storage directory, and viewer URL.

For automatic loading, install this repository as a local Pi package or add the absolute path to `src/index.ts` to your Pi extensions settings. The entry point is declared in `package.json` under `pi.extensions`. The extension does not change global Pi settings automatically.

The existing `/looplog` command, JSONL download names, and `.pi/loop-in-loop` storage directory are retained for compatibility with previously recorded sessions. The npm package name is `pi-recorder`; the project and viewer are named **Pi-Recorder**.

## Viewer features

- **Session list:** Search sessions recorded by this extension in the current project. View timestamps, status, turn counts, and token usage.
- **Execution timeline:** Inspect each task's model turns, model and thinking settings, stop reason, usage, duration, and tool relationships. Nested tools are indented under their parents. Hover over a model or the token statistic for additional information.
- **Details:** Filter by messages, context and requests, tools, or all events. Click an event to load its complete payload, then expand the raw JSON to inspect every field. Large fields remain complete inside scrollable panels.
- **Search and export:** Search full payloads, filter by exact event type, tool name, or errors, and download a session as JSONL.
- **Live updates:** The viewer receives change notifications over SSE and reconnects automatically. Loading older events pauses live following; select the follow-latest checkbox to resume.

The blue and green duration bar compares non-tool time with cumulative tool duration within a turn. Parallel tools can overlap, so cumulative tool time is not necessarily elapsed wall-clock time. Costs use Pi's estimates and do not represent an actual bill. Unavailable values are explicitly marked as not provided. The viewer interface currently uses Chinese labels.

## Storage and event format

Recordings are stored in the **project directory where Pi is running**:

```text
.pi/loop-in-loop/
  <base64url-encoded sessionId>/
    <recorderId>.jsonl
    <recorderId>.state.json
```

Each extension runtime gets a unique `recorderId`. Reloading, resuming, or starting another Pi process creates an independent fragment, so concurrent processes never write the same log file. Repeated `session_start` notifications within one active runtime reuse its recorder. The viewer combines fragments belonging to the same session.

Each JSONL line contains one event:

```json
{
  "schemaVersion": 1,
  "recorderId": "...",
  "sessionId": "...",
  "taskId": "...",
  "runId": "...",
  "turnId": "...",
  "seq": 1,
  "timestamp": "2026-10-27T12:00:00.000Z",
  "elapsedMs": 123.4,
  "type": "before_provider_request",
  "data": { "payload": {} }
}
```

Events without a task, run, or turn association omit those IDs and remain at session level. `elapsedMs` uses a monotonic clock within the recording instance. Downloads include every complete log fragment, ordered by `seq` within each fragment. To order events across fragments, use `timestamp`, `recorderId`, and `seq`.

Captured data includes:

- Raw and queued inputs, system prompts, context, and tool declarations.
- Provider request payloads as observed by the extension, response status and non-authentication headers, and raw provider stream events.
- Message lifecycle events, streaming updates, visible thinking, and final responses.
- Tool arguments, partial output, final results, errors, native execution duration, and nested tool-call IDs.
- Model and thinking-level changes, session naming, compaction, tree navigation, and fork, switch, and shutdown events.
- Final assistant messages' stop reasons, errors, token counts, cache usage, reasoning tokens, and cost estimates.

A task starts at `before_agent_start` and finishes at `agent_settled`, including retries and continuations. Steering and follow-up inputs submitted while a task runs remain associated with that task; consumed user messages appear under the turn that receives them. Each `agent_start` gets a new run ID, so retries that reset `turnIndex` remain distinct.

`recorder_start` includes the context available when the extension loads. **Messages from before recording began are not imported as new turns or counted toward recorded token usage.** Statistics use final assistant messages for captured turns; streaming snapshots, `turn_end`, and historical context do not add duplicate usage.

Capture boundaries:

- Only data exposed by Pi's public hooks is available. The recorder cannot recover thinking the model did not return, output truncated before a tool emitted it, or request stages hidden by the transport.
- Authentication request-header hooks are not subscribed to, model credential configuration is excluded, and authentication-related response headers are filtered. Prompt and tool bodies are preserved verbatim, including sensitive content placed in those bodies.
- Request payloads are snapshots taken when this extension's hook runs. Later extensions can still modify a request. Load Pi-Recorder after other request-transforming extensions to observe their changes.
- Raw events and the complete context for each request are preserved without content truncation or automatic cleanup. Long sessions can produce large files.

## View recordings after Pi exits

From the extension repository, run:

```sh
npm run viewer -- --project /path/to/your-project
```

Open the printed `http://127.0.0.1:<port>` URL. The operating system assigns an available port. The viewer listens only on the local machine, and all static assets are served locally. Press `Ctrl+C` to stop it.

A viewer started by `/looplog` closes when Pi exits, reloads, or replaces its session. Use the standalone command to continue browsing saved recordings.

## Development and validation

```sh
npm run check
npm test
npm run test:pi
```

- `check`: TypeScript type checking.
- `test`: Node tests covering snapshots, retries, nested tools, concurrent fragments, cancellation, disk failures, incomplete trailing lines, HTTP APIs, SSE, filtering, and downloads. Localhost listeners must be permitted.
- `test:pi`: Runs the installed `pi` CLI in RPC mode with isolated settings and an offline test provider. It executes real bash calls, produces two turns per task, and checks `/devtest`, the `/looplog` viewer, session replacement, resume, reload, and shutdown. It needs permission to listen on local ports. It does not call a paid model, read user authentication configuration, or open a real browser. Generated recordings stay in the ignored `test-workspace/smoke-*` directories; the latest path is listed in `test-workspace/latest-smoke.json`.

Run only the relevant test file during development:

```sh
node --import tsx --test test/trace.test.ts
node --import tsx --test test/server.test.ts
```

For a manual isolated session:

```sh
mkdir -p test-workspace
cd test-workspace
pi --verbose --no-extensions --no-mcp --no-skills --no-prompt-templates \
  --no-themes --no-context-files -e ../src/index.ts
```

Confirm the startup notification, then run `/devtest` and `/devtest example`. Expect `devtest: hello` and `devtest: example`. Submit a task that uses a tool and open `/looplog` to inspect live updates. Restart Pi or run `/reload` after changing the extension.

See the [Pi extension development and debugging guide](docs/pi-extension-development-debugging-guide.md) for a detailed workflow.

## Troubleshooting

- **No recordings:** Run `/looplog status`, check the extension path, and confirm the storage directory belongs to the project where Pi started. Older sessions that were never recorded are not scanned.
- **Recorder error:** The status bar and notifications show write errors, and the viewer displays failures from `.state.json`. Fix disk space or directory permissions, then run `/reload`.
- **Viewer disconnected:** The previous viewer closes when Pi exits or replaces its session. Run `/looplog` again or start the standalone viewer.
- **Interrupted task:** The log contains no final completion event. If its recorder stops heartbeating for 15 seconds, unfinished tasks are shown as interrupted.
- **Incomplete trailing line:** The viewer ignores an unfinished last line and retains every preceding complete line. Corrupt newline-terminated events produce an explicit error. Keep a copy of the original file before repairing it manually.
- **Freeing disk space:** Exit the relevant Pi session, back up or remove the project's `.pi/loop-in-loop` directory, then restart the viewer.

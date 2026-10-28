# Pi Extension Development and Debugging Guide

> A workflow for developing TypeScript extensions on a machine with Pi already installed.\
> Core principle: **Validate the extension in an isolated environment first,
> then progress to project loading, reloads, JSON/RPC, and integration tests.**

This guide covers generic Pi extension development. For Pi-Recorder setup,
recording behavior, and viewer commands, see the [README](../README.md).
`PI_EXT_DEBUG` is a convention used by the example logger in this guide;
it is not a built-in Pi flag or a switch for Pi-Recorder's automatic recording.

------------------------------------------------------------------------

## 1. Recommended development workflow

Develop and debug in this order:

``` text
Edit TypeScript source
        │
        ▼
Clean-room Pi
(--no-* + -e)
        │
        ▼
Extension Bootstrap
        │
        ▼
Command / Event Test
        │
        ▼
Tool-call Test
        │
        ▼
Ctrl+C / Restart
        │
        └──────────────► Edit the next version

Once stable:

-e for quick iteration
    ↓
.pi/extensions/ project loading
    ↓
/reload for runtime reloads
    ↓
-p non-interactive integration tests
    ↓
--mode json event-stream tests
    ↓
--mode rpc programmatic tests
    ↓
Package / installation tests
```

------------------------------------------------------------------------

## 2. Quick start: an isolated debugging command

Start extension development with:

``` bash
PI_EXT_DEBUG=1 \
pi \
  --verbose \
  --no-extensions \
  --no-skills \
  --no-prompt-templates \
  --no-themes \
  --no-context-files \
  -e ../src/index.ts
```

What each option does:

| Option | Purpose |
| --- | --- |
| `--verbose` | Print detailed startup and loading information. |
| `--no-extensions` | Disable automatic loading of other extensions. |
| `--no-skills` | Disable skill discovery and loading. |
| `--no-prompt-templates` | Disable prompt-template discovery and loading. |
| `--no-themes` | Disable theme discovery and loading. |
| `--no-context-files` | Disable project context-file loading. |
| `-e ../src/index.ts` | Explicitly load the extension under development. |
| `PI_EXT_DEBUG=1` | Enable the custom debug logger shown below. |

This reduces environmental variation and makes problems easier to isolate.

------------------------------------------------------------------------

# 3. Create a separate development directory

Start with a separate checkout instead of placing development source directly in:

``` text
~/.pi/agent/extensions/
```

Create a standalone project:

``` bash
mkdir -p ~/dev/pi-ext-test
cd ~/dev/pi-ext-test

npm init -y
mkdir -p src test-workspace
```

Directory layout:

``` text
pi-ext-test/
├── package.json
├── src/
│   └── index.ts
└── test-workspace/
```

The directories have separate responsibilities:

-   `src/`: extension source code.
-   `test-workspace/`: a project directory representing where users run Pi.

Run Pi from the test workspace:

``` bash
cd ~/dev/pi-ext-test/test-workspace
```

Use this as the working directory instead of the extension source directory.

This separates:

``` text
Extension Source
```

and:

``` text
Pi Working Directory
```

Keep the extension source and the Pi working directory independent.

------------------------------------------------------------------------

# 4. A minimal extension

`src/index.ts`：

``` ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify("DEV extension loaded", "info");
  });

  pi.registerCommand("devtest", {
    description: "Test development extension",

    handler: async (args, ctx) => {
      ctx.ui.notify(
        `devtest: ${args || "hello"}`,
        "info",
      );
    },
  });
}
```

The basic extension entry-point structure is:

``` text
Pi
 │
 └── Load Extension
       │
       ▼
export default function(pi)
       │
       ├── pi.on(...)
       ├── pi.registerTool(...)
       ├── pi.registerCommand(...)
       ├── pi.registerShortcut(...)
       └── ...
```

Keep the entry point minimal during early development.

------------------------------------------------------------------------

# 5. First stage: load only the extension under development

Enter the test workspace:

``` bash
cd ~/dev/pi-ext-test/test-workspace
```

Start Pi:

``` bash
pi --no-extensions -e ../src/index.ts
```

The environment is approximately:

``` text
Pi
 │
 ├─ X ~/.pi/agent/extensions/*
 ├─ X .pi/extensions/*
 │
 └─ ✓ ../src/index.ts
```

This is one of the most useful isolation techniques during development.

If loading fails here, there are far fewer possible causes to investigate.

------------------------------------------------------------------------

# 6. A fully isolated environment

To exclude additional Pi resources:

``` bash
pi \
  --no-extensions \
  --no-skills \
  --no-prompt-templates \
  --no-themes \
  --no-context-files \
  -e ../src/index.ts
```

This excludes:

``` text
Global Extensions
Project Extensions
Skills
Prompt Templates
Themes
Context Files
```

You can define a development alias:

``` bash
alias pidev='pi \
  --no-extensions \
  --no-skills \
  --no-prompt-templates \
  --no-themes \
  --no-context-files'
```

Then run:

``` bash
pidev -e ../src/index.ts
```

------------------------------------------------------------------------

# 7. Use `--verbose`

For loading, initialization, or dependency problems, run:

``` bash
pi \
  --verbose \
  --no-extensions \
  --no-skills \
  --no-prompt-templates \
  --no-themes \
  --no-context-files \
  -e ../src/index.ts
```

Use the output to distinguish these stages:

``` text
Extension was not loaded
        ↓
Import / module resolution failed
        ↓
Extension factory initialization failed
        ↓
API registration failed
        ↓
Event handler execution failed
```

Identify a specific failure stage instead of reporting only that the extension did not work.

Determine which lifecycle stage failed before investigating further.

------------------------------------------------------------------------

# 8. Debug logging conventions

During development, you can log directly:

``` ts
console.error("[my-ext] factory loaded");
```

For example:

``` ts
export default function (pi: ExtensionAPI) {
  console.error("[my-ext] factory loaded");

  pi.on("session_start", async (event, ctx) => {
    console.error("[my-ext] session_start", event);
  });

  pi.on("tool_call", async (event, ctx) => {
    console.error("[my-ext] tool_call", {
      toolName: event.toolName,
      input: event.input,
    });
  });
}
```

## Why use stderr for diagnostics

Use stderr for debugging:

``` ts
console.error(...)
```

Keep protocol output on stdout:

``` ts
console.log(...)
```

For agent and CLI development, maintain this separation:

``` text
stdout → Machine / Protocol Output
stderr → Debug / Diagnostic Logging
```

This matters especially in JSON mode, RPC mode, and shell pipelines.

------------------------------------------------------------------------

# 9. Use a shared logger

For a larger extension, centralize logging instead of scattering calls to:

``` ts
console.error(...)
```

Wrap the logger:

``` ts
const DEBUG = process.env.PI_EXT_DEBUG === "1";

export function debug(...args: unknown[]) {
  if (!DEBUG) {
    return;
  }

  console.error(
    `[my-ext ${new Date().toISOString()}]`,
    ...args,
  );
}
```

Usage:

``` ts
debug("extension loaded");

pi.on("tool_call", async (event) => {
  debug(
    "tool_call",
    event.toolName,
    event.input,
  );
});
```

Enable debugging:

``` bash
PI_EXT_DEBUG=1 pidev -e ../src/index.ts
```

Disable debugging:

``` bash
pidev -e ../src/index.ts
```

Control logging through configuration rather than repeatedly deleting debug statements.

------------------------------------------------------------------------

# 10. Two development modes

## 10.1 Mode A: quick iteration with `-e`

``` bash
pi --no-extensions -e ../src/index.ts
```

After editing the code:

``` text
Ctrl+C
   ↓
Restart Pi
```

This works well for debugging:

``` text
Import
Module Initialization
registerTool()
registerCommand()
registerProvider()
Global State
Extension Bootstrap
```

For initialization failures, use a full restart before relying on reload behavior.

------------------------------------------------------------------------

## 10.2 Mode B: project loading and `/reload`

Once basic behavior is stable, test automatic discovery and the reload lifecycle.

Create a project extension directory:

``` bash
cd ~/dev/pi-ext-test/test-workspace

mkdir -p .pi/extensions/my-ext
```

A symlink is convenient during development:

``` bash
ln -s ~/dev/pi-ext-test/src/index.ts \
  .pi/extensions/my-ext/index.ts
```

Then start Pi:

``` bash
pi
```

After editing the source, run this command inside Pi:

``` text
/reload
```

This exercises:

``` text
Auto Discovery
      +
Extension Reload Lifecycle
```

------------------------------------------------------------------------

# 11. `/reload` and state management

The reload lifecycle can be represented as:

``` text
Old Extension Runtime
        │
        │ session_shutdown
        ▼
      Unload
        │
        ▼
Load New TypeScript
        │
        ▼
New Extension Runtime
        │
        │ session_start
        ▼
       Ready
```

Treat the following as state local to one extension runtime:

``` ts
let state = ...
```

Persist it explicitly if it must survive a reload.

Pay particular attention to these resources:

``` text
Timer
File Watcher
Socket
Child Process
Connection Pool
Temporary Resource
External Client
```

Release them in a shutdown handler:

``` ts
pi.on("session_shutdown", async () => {
  // cleanup
});
```

Use this handler for cleanup.

Repeated reloads without cleanup:

``` text
/reload
/reload
/reload
```

can leave duplicate resources running:

``` text
3 × Timer
3 × File Watcher
3 × Child Process
3 × Socket
```

The lifecycle rule is:

> Treat `session_shutdown` as a required part of the extension lifecycle,
> and implement cleanup for every long-lived resource.

------------------------------------------------------------------------

# 12. Tool development conventions

Suppose the extension registers this tool:

``` ts
pi.registerTool({
  name: "hello",
  label: "Hello",
  description: "Say hello",

  parameters: Type.Object({
    name: Type.String(),
  }),

  async execute(toolCallId, params) {
    debug("hello.execute", {
      toolCallId,
      params,
    });

    return {
      content: [
        {
          type: "text",
          text: `Hello ${params.name}`,
        },
      ],
      details: {},
    };
  },
});
```

Start with deterministic checks before relying on the model to select tools.

Test in layers.

------------------------------------------------------------------------

## 12.1 Level 1：Extension Bootstrap

Start Pi:

``` bash
PI_EXT_DEBUG=1 pidev -e ../src/index.ts
```

Confirm that the logs include at least:

``` text
factory loaded
session_start
```

Resolve bootstrap failures before testing model behavior.

------------------------------------------------------------------------

## 12.2 Level 2：Command / Event

Test deterministic handlers first.

For example:

``` text
/devtest abc
```

Execution path:

``` text
Command
   ↓
Extension Handler
```

This does not depend on a model decision.

It checks that the extension runtime and handler registration work.

------------------------------------------------------------------------

## 12.3 Level 3：Tool Calling

Finally, test a model-driven tool call:

``` text
Use the hello tool to greet Alice.
```

Expected flow:

``` text
LLM
 ↓
Tool Selection
 ↓
tool_call
 ↓
hello.execute()
 ↓
tool_result
 ↓
LLM
```

Distinguish these failure cases:

``` text
The model did not select the tool
```

from:

``` text
The model selected the tool,
but execute() failed
```

They require different investigations.

------------------------------------------------------------------------

# 13. Non-interactive tests with `-p`

Once the extension is stable, use print / non-interactive mode:

``` bash
pi \
  --no-extensions \
  -e ../src/index.ts \
  -p "Use the hello tool to greet Alice."
```

This is useful for:

``` text
Shell Test
CI Test
Integration Test
Regression Test
```

Check the availability of UI APIs.

For example:

``` ts
if (ctx.hasUI) {
  ctx.ui.notify("Hello", "info");
}
```

For an extension that supports all of these modes:

``` text
TUI
Print
JSON
RPC
```

Guard interactive UI operations according to the current mode's capabilities.

------------------------------------------------------------------------

# 14. JSON Mode

For debugging the agent event flow, run:

``` bash
pi \
  --no-extensions \
  -e ../src/index.ts \
  --mode json
```

A terminal UI can suggest that:

``` text
Something happened in the TUI
```

JSON mode provides a more direct view of:

``` text
Event
Event
Tool Call
Tool Result
Assistant Response
...
```

It is useful for investigating:

``` text
Agent Loop
Tool Lifecycle
Event Ordering
Tool Result
Assistant Response
```

------------------------------------------------------------------------

# 15. RPC Mode

For more complex extensions, use RPC mode:

``` bash
pi \
  --no-extensions \
  -e ../src/index.ts \
  --mode rpc
```

Architecture:

``` text
Test Harness
     │
     │ JSON / RPC
     ▼
   Pi RPC
     │
     ▼
 Extension
     │
     ▼
 Agent Loop
```

Build a programmatic integration test around this sequence:

``` text
Start Pi
   ↓
Send Prompt
   ↓
Receive Events
   ↓
Assert Tool Call
   ↓
Assert Tool Result
   ↓
Assert Assistant Result
```

This is a useful integration-test layer for complex agent extensions.

------------------------------------------------------------------------

# 16. Recommended project structure

As an extension grows, use a structure such as:

``` text
my-pi-extension/
├── package.json
├── tsconfig.json
│
├── src/
│   ├── index.ts
│   │
│   ├── events/
│   │   ├── tool-call.ts
│   │   └── session.ts
│   │
│   ├── tools/
│   │   ├── foo.ts
│   │   └── bar.ts
│   │
│   ├── commands/
│   │   └── debug.ts
│   │
│   ├── state/
│   │   └── store.ts
│   │
│   └── utils/
│       └── logger.ts
│
├── test/
│   ├── unit/
│   └── integration/
│
└── sandbox/
```

Keep `index.ts` focused on registration:

``` ts
export default function (pi: ExtensionAPI) {
  registerEvents(pi);
  registerTools(pi);
  registerCommands(pi);
}
```

Split responsibilities into modules instead of letting:

``` text
index.ts
```

grow into a single implementation file thousands of lines long.

------------------------------------------------------------------------

# 17. Dependency management

Use these files and directories:

``` text
package.json
node_modules/
```

to manage development dependencies.

Example:

``` json
{
  "name": "my-pi-extension",
  "private": true,
  "type": "module",
  "dependencies": {},
  "devDependencies": {
    "typescript": "^5"
  }
}
```

Separate these dependency categories:

``` text
Runtime Dependency
        ↓
dependencies

Typecheck / Test / Build Dependency
        ↓
devDependencies
```

A dependency available on your development machine may not resolve in a published installation.

------------------------------------------------------------------------

# 18. Use a separate `PI_CODING_AGENT_DIR`

Use a dedicated agent
directory to isolate development from your normal Pi environment.

For example:

``` bash
mkdir -p ~/.pi-dev/agent
```

Then run:

``` bash
PI_CODING_AGENT_DIR="$HOME/.pi-dev/agent" \
pi \
  --verbose \
  --no-extensions \
  --no-skills \
  --no-prompt-templates \
  --no-themes \
  --no-context-files \
  -e ../src/index.ts
```

This keeps development settings and resources separate from your normal Pi environment.

Conceptually:

``` text
Normal Pi
    │
    └── ~/.pi/agent

Development Pi
    │
    └── ~/.pi-dev/agent
```

A separate agent directory is useful for long-running extension development.

------------------------------------------------------------------------

# 19. Recommended shell alias

Add an alias to your shell configuration:

``` bash
alias pidev='PI_CODING_AGENT_DIR="$HOME/.pi-dev/agent" pi \
  --verbose \
  --no-extensions \
  --no-skills \
  --no-prompt-templates \
  --no-themes \
  --no-context-files'
```

Then run:

``` bash
cd ~/dev/my-pi-extension/test-workspace

PI_EXT_DEBUG=1 \
pidev -e ../src/index.ts
```

This starts the standard isolated development environment.

------------------------------------------------------------------------

# 20. Troubleshooting order

Investigate extension problems in this order:

``` text
1. Did Pi start?
        ↓
2. Was the extension module loaded?
        ↓
3. Did the extension factory execute?
        ↓
4. Were the APIs registered successfully?
        ↓
5. Did session_start fire?
        ↓
6. Do commands and events work?
        ↓
7. Does the tool's execute() function work?
        ↓
8. Is the tool result correct?
        ↓
9. Does the agent consume the tool result correctly?
        ↓
10. Is the final assistant response correct?
```

Establish the earlier stages before diagnosing the final response.

------------------------------------------------------------------------

# 21. Development stages

Divide extension development into four stages.

## Stage A --- Bootstrap

Goal:

``` text
The extension loads reliably
```

Use:

``` bash
pi --no-extensions -e ../src/index.ts
```

Test:

-   Import
-   Dependency Resolution
-   Extension Factory
-   API Registration
-   Session Lifecycle

------------------------------------------------------------------------

## Stage B --- Functional

Goal:

``` text
The extension's behavior is correct
```

Test:

-   Commands
-   Events
-   Tools
-   State
-   Cleanup

------------------------------------------------------------------------

## Stage C --- Agent Integration

Goal:

``` text
The extension works correctly with the agent loop
```

Use:

``` text
-p
--mode json
```

Test:

-   Tool Selection
-   Tool Arguments
-   Tool Result
-   Event Ordering
-   Assistant Response

------------------------------------------------------------------------

## Stage D --- Harness Integration

Goal:

``` text
The extension supports programmatic testing and external harnesses
```

Use:

``` text
--mode rpc
```

Test:

-   RPC Protocol
-   Event Streaming
-   Automated Assertions
-   Regression Tests
-   CI

------------------------------------------------------------------------

# 22. Recommended complete workflow

For everyday development:

``` bash
cd ~/dev/my-pi-extension/test-workspace

PI_EXT_DEBUG=1 \
PI_CODING_AGENT_DIR="$HOME/.pi-dev/agent" \
pi \
  --verbose \
  --no-extensions \
  --no-skills \
  --no-prompt-templates \
  --no-themes \
  --no-context-files \
  -e ../src/index.ts
```

Development order:

``` text
① Clean-room `-e`
        ↓
② Bootstrap / Command / Event
        ↓
③ Tool Execution
        ↓
④ Project `.pi/extensions/`
        ↓
⑤ `/reload`
        ↓
⑥ `-p`
        ↓
⑦ `--mode json`
        ↓
⑧ `--mode rpc`
        ↓
⑨ Package / Install Test
```

------------------------------------------------------------------------

# 23. Core development practices

Follow these practices when developing a Pi extension:

1.  **Separate the source directory from the test workspace.**
2.  **Start with `--no-extensions -e` before installing the extension.**
3.  **Use the full isolated `--no-*` environment for complex problems.**
4.  **Write diagnostics to stderr and preserve stdout for protocol output.**
5.  **Control the debug logger with an environment variable.**
6.  **Use a full Pi restart to investigate bootstrap problems.**
7.  **Test `/reload` after basic extension behavior is stable.**
8.  **Clean up every long-lived resource in `session_shutdown`.**
9.  **Test deterministic commands and events before model-driven tool selection.**
10. **Distinguish a model not selecting a tool from a tool execution failure.**
11. **Use `-p` for non-interactive tests.**
12. **Inspect the agent event flow in JSON mode.**
13. **Use RPC mode for automated integration tests of complex extensions.**
14. **Keep `index.ts` small and separate tool, event, and state modules.**
15. **Separate runtime dependencies from development dependencies.**
16. **Use a dedicated `PI_CODING_AGENT_DIR` for ongoing development.**
17. **Verify packaging and installation after functional validation.**

------------------------------------------------------------------------

## Recommended debugging baseline

If you keep only one debugging command, use:

``` bash
PI_EXT_DEBUG=1 \
PI_CODING_AGENT_DIR="$HOME/.pi-dev/agent" \
pi \
  --verbose \
  --no-extensions \
  --no-skills \
  --no-prompt-templates \
  --no-themes \
  --no-context-files \
  -e ../src/index.ts
```

Use this command as the standard **isolated debugging baseline** for Pi extension development.

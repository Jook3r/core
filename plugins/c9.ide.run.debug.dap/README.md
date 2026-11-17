# c9.ide.run.debug.dap

A debugger for Cloud9's debug panel that speaks the
[Debug Adapter Protocol](https://microsoft.github.io/debug-adapter-protocol/)
(DAP), the protocol of the debuggers of VS Code. One client, so a language
gets a debugger by naming its adapter in a runner.

## What it gives

In the Debugger panel, as with the Node.js debugger:

- **Breakpoints**, also with a condition, set before or while the program
  runs.
- The **call stack**; a click on a frame shows its place and its variables.
- **Variables** by scope (e.g. Locals and Globals), objects and lists opened
  on demand; a value can be changed where the adapter allows it.
- **Watch expressions** and the **Immediate** window, evaluated in the
  selected frame.
- **Step into, over and out**, **resume** and **pause**.
- **Pause on exceptions**: none, uncaught or all, with the button of the
  panel. (Delve always stops at a panic.)
- A page that is loaded again finds the session where it was.

When the program stops in a file outside the workspace (a Go panic stops
inside the runtime), the first frame of the workspace is the one shown.

## Which languages

**Python** — the *Python 3* runner, with [debugpy](https://github.com/microsoft/debugpy).
`scripts/install-sdk.sh` installs it to `~/.c9/debugpy`; a debugpy of the
project's own `python3` (`pip install debugpy`) is used when that folder is
missing. The older *Python* runner keeps its debugger (ikpdb).

**Go** — the *go* runner, with [Delve](https://github.com/go-delve/delve),
which is not installed by Cloud9:

    go install github.com/go-delve/delve/cmd/dlv@latest

(the version of Delve has to know the version of Go: an older Go needs an
older Delve, e.g. `dlv@v1.25.2` for Go 1.24). It is looked for on the PATH,
in `~/go/bin` and in Go's own `GOPATH`.

To debug: open the file, turn on the bug button of the Run tab (or of the
output tab) and run.

## Another language

A runner (Run > Run With > New Runner, or a file in `plugins/c9.ide.run/runners`)
starts the program with its adapter listening on a port of `127.0.0.1`, and
says how to attach to it:

    {
        "script": [
            "if [ \"$debug\" == true ]; then",
            "    my-adapter --listen 127.0.0.1:15475 \"$file\" $args",
            "else",
            "    my-language \"$file\" $args",
            "fi"
        ],
        "debugger": "dap",
        "debugport": 15475,
        "dap": {
            "adapter": "my-adapter",
            "request": "attach",
            "arguments": {}
        },
        "selector": "source.mylanguage"
    }

- `debugport`: the port the adapter listens on. The next port is used too
  (by the proxy below), so runners that can be debugged at the same time
  are two ports apart.
- `dap.request`: `attach` (the default) or `launch`; `dap.arguments`: the
  arguments of that request, as the adapter's documentation has them for
  VS Code's `launch.json`.
- `dap.adapter`: the adapter's name, sent to it as `adapterID`.

The adapter has to speak DAP over TCP (most can: `debugpy --listen`,
`dlv --headless`, `lldb-dap --connection`, `rdbg --open --port`). The
program's own output is what the adapter prints to the terminal of the Run
tab.

## How it works

- `dap.js` (in the browser) is the debugger plugin: it registers the type
  `dap` with `c9.ide.run.debug` and translates between the debug panel and
  the protocol: `initialize`, `attach` or `launch`, the breakpoints of every
  file, `configurationDone`; then `stopped` events, `stackTrace`, `scopes`,
  `variables`, `evaluate`, `next`, `stepIn`, `stepOut`, `continue`, `pause`.
- `netproxy.js` runs on the server (with `node -e`, as the other
  debuggers' proxies do). It holds the TCP connection to the adapter, so the
  session outlives the page, and does the protocol's framing: the adapter's
  messages have a `Content-Length` header counted in bytes, the IDE gets
  and sends one JSON message a line. It ends with the adapter.
- When the program is over, the adapter is told to end as well (a headless
  Delve would wait for another client).

`netproxy_test.js` tests the proxy against a scripted adapter;
`test/smoke.js` debugs a Python file in a browser (skipped without debugpy).

Cloud9 3.0 SDK for Plugin Development
======================================

This is the core repository for the Cloud9 v3 SDK. The SDK allows you to run a version of Cloud9 that allows you to develop plugins and create a custom IDE based on Cloud9.
 
#### Creating Plugins ####

Run Cloud9 as described below, then follow the tutorials on [writing
plugins](https://cloud9-sdk.readme.io/docs/getting-started-with-cloud9-plugins)
and [working on the core plugins](https://cloud9-sdk.readme.io/docs/contributing-to-cloud9),
and the rest of the [SDK documentation](https://cloud9-sdk.readme.io/docs).
c9.io and docs.c9.io are gone (they redirect to AWS), so the parts of the
tutorials that use them don't work.

File > New Plugin makes a plugin in `~/.c9/plugins`. Tools > Developer >
Start in Debug Mode opens a window where the Plugin Explorer loads and
reloads it while you work on it, for that browser session. To load it every
time Cloud9 starts, tick it in Preferences > User Settings > Plugins; the
list there shows whether each loaded, or the error in its code.

#### Installation ####

This fork runs on Ubuntu 24.04/26.04 with Node.js 24 LTS (16 or newer works),
tmux 3.x and Python 3. Install the system packages, then the SDK:

    sudo apt-get install -y git tmux python3 python3-venv build-essential
    git clone https://github.com/Jook3r/core.git onlineIDE
    cd onlineIDE
    scripts/install-sdk.sh

The Claude and DeepSeek panels run Claude Code, which the setup doesn't
install. Install it as the user Cloud9 runs as (it goes to `~/.local/bin`;
the panels find it there without a PATH change):

    curl -fsSL https://claude.ai/install.sh | bash

To update the SDK to the latest version run:

    git pull
    scripts/install-sdk.sh

`package-lock.json` has the version and the checksum of every package, so
every install gets the same ones. The four packages of Cloud9's own that
are not on npm (emmet, nak, tern, tern_from_ts) are tarballs in `vendor/`:
an install needs npm's registry and nothing else. After changing a
dependency in `package.json`, run `npm install --package-lock-only` and
commit the lockfile with it.

`npm install` deletes the modules that are in git in `node_modules`
(architect, kaefer, smith and others: they are not in `package.json`);
`scripts/install-sdk.sh` sets them aside while npm runs. If you run npm
yourself, run `git checkout HEAD -- node_modules` afterwards.

The `overrides` in `package.json` move dependencies of old packages
(engine.io 3, optimist, tern) to fixed versions. npm 9.2, Ubuntu's `npm`
package, fails on some forms of overrides: none for a file dependency, no
`npm:` aliases, and `"."` set to `"$name"` for a direct dependency. `npm
audit` reports no advisories.

The packed client is minified with Terser. The client code and plugins can
be written in current JavaScript (`const`, arrow functions, `async`,
classes, `?.`): it is minified as it is, not turned into older syntax, so
the browser has to know what the code uses.

To run Cloud9 on a server behind Apache with HTTPS, see
[deploy/README.md](deploy/README.md).

#### Starting Cloud9 ####

Cloud9 needs a username and password, given with `-a` or the `C9_AUTH`
environment variable (which keeps the password out of `ps`):

    C9_AUTH=user:password node server.js -w ~/workspace --packed

An address that tries 10 different wrong passwords within 15 minutes is
refused for 15 minutes; wrong passwords and logins are written to the log.

The following options can be used:

    --settings       Settings file to use
    --help           Show command line options.
    -t               Start in test mode
    -k               Kill tmux server in test mode
    -b               Start the bridge server - to receive commands from the cli  [default: false]
    -w               Workspace directory
    --port           Port                                       [default: 8181]
    --debug          Turn debugging on
    --listen         IP address of the server                   [default: 127.0.0.1]
    --readonly       Run in read only mode
    --packed         Use the prebuilt client (built by scripts/install-sdk.sh, or scripts/makestandalone.sh --compress)
    --auth, -a       Basic Auth username:password; -a : runs without a login (localhost only)
    --no-cache       Don't use the cached version of CSS

Now visit [http://localhost:8181/ide.html](http://localhost:8181/ide.html) to load Cloud9.

Terminals and runners have the `c9` command on their PATH: `c9 open file`
opens a file in an editor tab (a file in the workspace or the home folder).
With Preferences > User Settings > Terminal > Use Cloud9 as the Default
Editor, `git commit` opens the message in a tab and waits until you close it.

The terminals draw 24-bit colors, italics and crossed out text, and set
`COLORTERM=truecolor`. Terminals of a tmux server that was started before
this was added keep 256 colors until that server is gone: after a reboot,
or `tmux -L cloud93.4 kill-server` (with the number of `tmux -V`), which
ends what runs in the terminals.

JavaScript and TypeScript files get error markers, completion, parameter
hints and jump to definition from TypeScript 7's language server
([plugins/c9.ide.language.lsp](plugins/c9.ide.language.lsp/README.md)).

With a DeepSeek API key, the editor can suggest code at the cursor as you type,
greyed out ("ghost text"; Tab accepts it): Preferences > General > DeepSeek
Inline Completions ([plugins/c9.ide.deepseek](plugins/c9.ide.deepseek/README.md#inline-completions)).

Code can be formatted on save (or with Edit > Code Formatting) by a command
that reads it and writes the formatted code, set per language in Project
Settings (Code Formatters, and Python, JavaScript and Go Support): `ruff`
for Python (installed by the setup), `gofmt`, `prettier`, `rustfmt`, ...
Go formats on save by default; JavaScript uses the built-in JSBeautify
unless you set a command.

In a Git repository the code editor marks the lines that differ from the
staged version as you type (Goto > Next Change, Previous Change); right-click
the line numbers for Revert Change and Show Git Blame. The Changes panel
shows the current branch: click it to switch branches or create one
([plugins/c9.ide.scm](plugins/c9.ide.scm/README.md)).

#### Other folders ####

`/ide.html?w=/path/to/folder` opens the IDE with another folder than the
workspace: a folder inside the workspace or inside your home folder (any
other path opens the workspace).

A folder keeps its settings for Cloud9 in its `.c9` folder
(`project.settings`, `state.settings`), and some of them run commands on the
server: a code formatter when a file is saved, the options of the Python
linter. So for a folder that is not the workspace, Cloud9 starts in
Restricted Mode: without the folder's settings, without writing any, and it
asks whether you trust the folder. **Trust Folder** (later: Cloud9 > Trust
This Folder...) adds it to your trusted folders (`~/.c9/trusted.folders`)
and loads the IDE again with the folder's settings. Trust a folder only if
you know where its files come from. The workspace the server was started
with (`-w`) is always trusted.

The Python linter doesn't read the `pylintrc` or `pyproject.toml` of a
file's folder: such a file can name code to run, and a cloned repository
would run its own when one of its files is opened. Project Settings > Python
Support has a checkbox to use them, for a workspace whose folders you trust.

A Run tab that was open when you left is shown again, with its output; its
command is not started again.

#### Previews ####

Preview (next to Run) shows an HTML, Markdown, SVG or PDF file of the
workspace in a pane, and follows it while you edit. A page in the preview is
not trusted: it is in the browser's sandbox, where its scripts run with an
origin of their own. It can't reach the IDE around it, and it can't use
your login to read or write files or to run commands on the server. The
same goes for the HTML in a Markdown file, for a file opened by its address
(`/preview/...`, also in a tab of its own), and for every page the server
sends except the IDE itself, which no page can show in a frame.

In the sandbox a page's ordinary scripts, style sheets and images load, the
page shows a change to its style sheet as you type, and the preview's
address bar follows the links you click. A page can't, there:

- load ES modules (`<script type="module">`), web fonts or its own files
  with `fetch` (the browser asks for these without your login, and the
  server refuses them);
- use cookies, `localStorage` or workers.

Of the IDE's keys, those that switch tabs and panes, close the preview and
open a panel work while the keyboard focus is in the page; Run and Build
don't.

For a page that needs more, serve its folder from a terminal:

    cd ~/workspace/site && python3 -m http.server $PORT --bind $IP

and open it with Preview > Preview Running Application
([deploy/README.md](deploy/README.md), "Your app"), or type its address,
like `http://localhost:8080`, in the preview's address bar. There the page
has an address, and so an origin, of its own.

#### Running Tests ####

    scripts/run-tests.sh

runs the server-side tests (the `*_test.js` marked `"use server"`, and the
tests of the editor, Ace), the client-side tests (the other `*_test.js`, each
in a browser, by `test/client.js`; those that have been failing since before
this fork are listed there and left out) and a smoke test, `test/smoke.js`.
The smoke test starts Cloud9 with a login in a temporary home folder and
checks it in a browser: the login limit, files, search, a terminal,
`c9 open`, the Welcome page, the language server, the Python debugger (skipped without debugpy),
the previews' sandbox, a file changed on disk,
another folder as the
workspace, the Claude Code IDE bridge, a DeepSeek inline completion, and a chat in the Claude and
DeepSeek panels against a mock API (skipped without Claude Code).
The tests in a browser need Node.js 18+ and,
once, Chromium for Playwright:

    npx --prefix test playwright install --with-deps chromium

`scripts/run-tests.sh server`, `client` or `smoke` runs one of the three. The packages
the tests need go to `test/node_modules`. GitHub Actions runs them on every
push (`.github/workflows/tests.yml`).

#### Language servers ####

JavaScript and TypeScript have a language server built in; Python, Go, Rust,
C/C++, PHP, Ruby, shell scripts, Lua, YAML, JSON, CSS and HTML get theirs
when it is installed on the server, and any other LSP server can be added.
They give hover, Find References, Rename Symbol across files, Quick Fix and
Format Document next to completion and markers. See
`plugins/c9.ide.language.lsp/README.md`.

#### Debuggers ####

Next to the Node.js debugger there is one for the Debug Adapter Protocol,
the protocol of VS Code's debuggers: Python (the *Python 3* runner, with
debugpy, which `scripts/install-sdk.sh` installs) and Go (with Delve, when
it is installed) are debugged through it, with breakpoints, the call stack,
variables, watches, stepping and pause on exceptions; another language
needs a runner that names its adapter. See
`plugins/c9.ide.run.debug.dap/README.md`.

#### The Claude and DeepSeek panels ####

The two chat panels are one panel (`plugins/c9.ide.agent`) with a provider
each: see `plugins/c9.ide.claude/README.md` and
`plugins/c9.ide.deepseek/README.md` for what they do, and
`plugins/c9.ide.agent/README.md` for how they are built.

#### Claude Code in a terminal ####

A `claude` (Claude Code) started in a Cloud9 terminal connects to the IDE:
it knows the file and selection you are looking at, shows the changes it
proposes as a diff in a tab to accept or reject, and is told the editor's
markers for the files it edits. See "Claude Code in a terminal" in
`plugins/c9.ide.claude/README.md`.

#### The editor ####

The editor is [Ace](https://github.com/ajaxorg/ace) 1.45.2, in
`plugins/node_modules/ace`. `scripts/vendor-ace.js` puts another release
there and applies Cloud9's few changes to it again; see
`plugins/node_modules/ace/CLOUD9.md`.

Happy coding, Cloud9

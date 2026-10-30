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

`npm install` deletes the modules that are vendored in `node_modules`;
`scripts/install-sdk.sh` checks them out again. If you run npm yourself, run
`git checkout HEAD -- node_modules` afterwards.

The `overrides` in `package.json` move dependencies of old packages
(connect 2.12, engine.io 3, less 2, tern) to fixed versions; npm applies
them only to packages it installs, so `scripts/install-sdk.sh` reinstalls
those. `npm audit` then reports two advisories, both in parts of connect
2.12 that Cloud9 doesn't load: the `methodOverride` middleware (XSS) and
the multipart parser (multiparty; uploads use their own parser).

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

JavaScript and TypeScript files get error markers, completion, parameter
hints and jump to definition from TypeScript 7's language server
([plugins/c9.ide.language.lsp](plugins/c9.ide.language.lsp/README.md)).

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

#### Running Tests ####

    scripts/run-tests.sh

runs the server-side tests (`*_test.js`) and a smoke test, `test/smoke.js`.
The smoke test starts Cloud9 with a login in a temporary home folder and
checks it in a browser: the login limit, files, search, a terminal,
`c9 open`, the Welcome page, and a chat in the Claude and DeepSeek panels
against a mock API (skipped without Claude Code). It needs Node.js 18+ and,
once, Chromium for Playwright:

    npx --prefix test playwright install --with-deps chromium

`scripts/run-tests.sh server` or `smoke` runs one of the two. The packages
the tests need go to `test/node_modules`. GitHub Actions runs both on every
push (`.github/workflows/tests.yml`).

Happy coding, Cloud9

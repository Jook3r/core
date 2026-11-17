# c9.ide.language.lsp

Language servers (the [Language Server Protocol](https://microsoft.github.io/language-server-protocol/))
for the editor.

## What a server gives

- **Markers** for errors as you type.
- **Completion**, e.g. the members of an object after `.`.
- **Parameter hints** while typing the arguments of a call.
- **Jump to definition** (F3), also into other files; **Go to Type
  Definition** and **Go to Implementation** in the Goto menu.
- **Hover**: rest the mouse on a name for its type and documentation
  (it can be turned off in Preferences > Project Settings > Language
  Servers).
- **Find References** (Shift-F12): every use, in every file of the project,
  as a list with each line; Enter or a click goes there.
- **Rename Symbol** (F2): in every file that uses it. Files that are open
  change in the editor (one step to undo in each), the others on disk.
- **Quick Fix** (Alt-Enter): the server's fixes and refactorings for the
  cursor's place or the selection, e.g. add a missing import.
- **Format Document** (Shift-Alt-F), with the editor's tab size.
- The **other places of a name** are highlighted when the cursor is on it.
- **Outline**, where Cloud9 has none of its own.

All of them are in the editor's context menu. What a server does not
support says so when asked ("The language server can't rename").

## Which servers

**JavaScript and TypeScript** (`.js`, `.mjs`, `.cjs`, `.jsx`, `.ts`, `.mts`,
`.cts`, `.tsx`): the language server built into TypeScript 7 (`tsc --lsp
--stdio`), which Cloud9 installs. It understands current syntax; JavaScript
gets syntax errors, and type errors too with `// @ts-check` at the top of
the file or `"checkJs": true` in a `jsconfig.json`. It works next to the
older JavaScript tools (Tern, ESLint, the outline); completions from both
are merged, the language server's first.

**Other languages**: a server is used when it is installed, and nothing is
said when it is not. Cloud9 looks for it on the server's PATH and in
`~/.local/bin`, `~/go/bin`, `~/.cargo/bin` and `~/.npm-global/bin`.

| Language | Program (the first that is found) | To install, for example |
|---|---|---|
| Python | `basedpyright-langserver`, `pyright-langserver`, `pylsp`, `ruff server` | `npm install -g pyright` |
| Go | `gopls` | `go install golang.org/x/tools/gopls@latest` |
| Rust | `rust-analyzer` | `rustup component add rust-analyzer` |
| C and C++ | `clangd` | `apt install clangd` |
| PHP | `intelephense`, `phpactor` | `npm install -g intelephense` |
| Ruby | `ruby-lsp`, `solargraph` | `gem install ruby-lsp` |
| Shell scripts | `bash-language-server` | `npm install -g bash-language-server` |
| Lua | `lua-language-server` | see luals.github.io |
| YAML | `yaml-language-server` | `npm install -g yaml-language-server` |
| JSON, CSS/SCSS/Less, HTML | `vscode-json-language-server`, `vscode-css-language-server`, `vscode-html-language-server` | `npm install -g vscode-langservers-extracted` |

After installing one, reload the IDE's page. Preferences > Project Settings
> Language Servers turns each off. For Python the server works next to
Cloud9's own Python support (Jedi, Pylint): both give markers.

**Any other server** that speaks LSP over stdio: Preferences > Project
Settings > Language Servers > Other servers, as JSON, e.g.

    [{ "name": "zig", "command": ["zls"], "extensions": ["zig"] }]

(`languages`: the editor's modes it is for, if they are not the extensions;
`languageIds`: `{ "ext": "id" }`, if the server wants another id than the
extension.) This is kept in your user settings, not in the project's: a
folder can't name a program for the server to run.

The servers of Go, Rust and Ruby run code of the project to understand it
(build scripts, a `Gemfile`). They are not started for a folder that is not
trusted (Restricted Mode, see "Other folders" in the main README).

## How it works

- `scripts/install-sdk.sh` (npm) installs TypeScript 7 as `typescript-native`,
  an alias, so that the old TypeScript 1.0 that Tern uses stays where it is.
  npm adds the native program for the server's platform, e.g.
  `node_modules/@typescript/typescript-linux-arm64/lib/tsc`.
- `lsp.js` tells the language worker which servers to run.
  `worker/lsp_worker.js`, in the worker, starts them in the workspace with
  `workerUtil.spawn` (which can write to a process's stdin for this), speaks
  JSON-RPC with them, and keeps the open files in sync.
- `features.js` is what the IDE shows of a server beyond what the language
  worker asks by itself: the hover tooltip, the list of places, the rename
  box, the commands. It asks the client in the worker (`lsp_request`, with
  the document's text as it is at that moment) and applies the edits that
  come back, per file.
- Each IDE tab has its own server processes (about 70 MB for TypeScript on
  a small project). They stop about 15 seconds after the tab closes; one
  that exits is restarted, 3 times at most.
- Projects are the server's: TypeScript reads `tsconfig.json` or
  `jsconfig.json`; a file without one is checked with the files it imports.

## Known limitations

- Completion inserts the name only: no automatic imports (Quick Fix adds
  the import afterwards), no snippets.
- A rename or a fix that creates, renames or deletes files leaves those
  out, and so are changes to files outside the workspace and the home
  folder; the message says how many.
- Jump to definition into a file outside the workspace and the home folder
  (e.g. TypeScript's own `lib.dom.d.ts` when Cloud9 is installed elsewhere)
  does nothing, since the IDE can't open it.
- Servers get no settings of their own (TypeScript: one, so that Rename
  Symbol renames an imported name everywhere).
- After pulling this, run `scripts/install-sdk.sh` (it installs TypeScript 7
  and rebuilds the packed client); without TypeScript 7 a JavaScript or
  TypeScript file shows a message once.

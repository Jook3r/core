# c9.ide.language.lsp

Language servers (the [Language Server Protocol](https://microsoft.github.io/language-server-protocol/))
for the editor. For now there is one: the language server built into
TypeScript 7 (`tsc --lsp --stdio`), for JavaScript and TypeScript files
(`.js`, `.mjs`, `.cjs`, `.jsx`, `.ts`, `.mts`, `.cts`, `.tsx`). It
understands current syntax (`async`/`await`, `?.`, `??`, class fields,
JSX) and gives:

- **Markers** for errors as you type: type errors in TypeScript; syntax
  errors in JavaScript, and type errors too with `// @ts-check` at the top
  of the file or `"checkJs": true` in a `jsconfig.json`.
- **Completion**, e.g. the members of an object after `.`.
- **Parameter hints** while typing the arguments of a call.
- **Jump to definition**, also into other files.
- **Outline** for TypeScript files (JavaScript keeps its own).

It works next to the older JavaScript tools (Tern, ESLint, the outline);
completions from both are merged, the language server's first.
Preferences > Project Settings > Language Servers turns it off.

## How it works

- `scripts/install-sdk.sh` (npm) installs TypeScript 7 as `typescript-native`,
  an alias, so that the old TypeScript 1.0 that Tern uses stays where it is.
  npm adds the native program for the server's platform, e.g.
  `node_modules/@typescript/typescript-linux-arm64/lib/tsc`.
- `lsp.js` tells the language worker which servers to run.
  `worker/lsp_worker.js`, in the worker, starts them in the workspace with
  `workerUtil.spawn` (which can write to a process's stdin for this), speaks
  JSON-RPC with them, and keeps the open files in sync.
- Each IDE tab has its own server process (about 70 MB for a small
  project). It stops about 15 seconds after the tab closes; one that exits
  is restarted, 3 times at most.
- Projects are TypeScript's: the server reads `tsconfig.json` or
  `jsconfig.json`; a file without one is checked with the files it imports.
- The client is generic: another server (Pyright, gopls, ...) is another
  entry in `config()` in `lsp.js`.

## Known limitations

- Completion inserts the name only: no automatic imports, no snippets.
- No rename or quick fixes through the server yet.
- Jump to definition into a file outside the workspace and the home folder
  (e.g. TypeScript's own `lib.dom.d.ts` when Cloud9 is installed elsewhere)
  does nothing, since the IDE can't open it.
- After pulling this, run `scripts/install-sdk.sh` (it installs TypeScript 7
  and rebuilds the packed client); without TypeScript 7 a JavaScript or
  TypeScript file shows a message once.

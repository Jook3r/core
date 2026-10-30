# c9.ide.claude

A chat panel for [Claude Code](https://docs.claude.com/en/docs/claude-code) on the
right side of the IDE, next to Outline and Debugger.

It does not call the API itself: it runs the `claude` CLI that is installed on
the server, in headless streaming mode, as the user Cloud9 runs as. Your login,
settings, `CLAUDE.md`, MCP servers and permission rules apply exactly as in the
terminal.

## Usage

1. Install Claude Code on the server and log in once from a terminal:
   `curl -fsSL https://claude.ai/install.sh | bash` (or
   `npm install -g @anthropic-ai/claude-code`), then run `claude`.
2. Open the **Claude** panel (right edge of the window, or Window > Claude).
3. Type a message. Enter sends, Shift+Enter adds a line, Esc (anywhere in the
   panel, except in an open menu) stops Claude, and Shift+Tab switches the
   permission mode. While Claude works the input queues the next message.
   Paste, drop or attach (paperclip) images: each shows as a chip (thumbnail,
   name, size; a larger preview on hover). Large images are downscaled in the
   browser to at most 1568 px on the long edge.

- While Claude works, a row above the input says what it does now (Thinking
  with the token estimate, Running `cmd`, Reading/Editing/Writing a file,
  Searching, Waiting for your approval, Retrying, Compacting...), with the
  elapsed time and "Esc to stop". While Claude thinks that row says
  "Thinking... 1.2k tokens"; when it is done the chat shows "Thought for 6s".
  Set `localStorage["claude-debug"] = 1` in the browser console to log when
  each event arrives.
- Tool calls show as cards (Read, Edit with an inline diff, Write, Bash, ...)
  with a spinner while they run; errors open with the output under the card's
  title. Click a file name to open it in the editor.
- When Claude needs permission, the prompt takes the place of the input box
  (the conversation dims): **1 Yes**, **2 Yes, ...** with the option the CLI
  offers (for example "allow all edits this session"), **3 No**. Keys 1-3,
  Up/Down and Enter work; Esc (or No) denies and stops the turn. Write in "Tell
  Claude what to do instead" and press Enter to deny and let Claude go on with
  your note. Several requests come one at a time ("1 of 2"). Clicks and keys
  in the first half second of a prompt are ignored.
- The input's footer has the model pill (the model and effort the CLI really
  applies, e.g. "Haiku 5.5 · Medium") and the mode button (Ask, Accept edits,
  Plan, or "From settings", the default). The model menu lists the CLI's models
  with their descriptions and ends with the effort: Auto, or a level the model
  supports (none for a model without effort levels), and, where the model
  supports it, the **Ultracode** switch (multi-agent workflows for big tasks;
  it uses many more tokens). Ultracode is off by default and stays on only
  until the page is reloaded; when on, the pill shows an "Ultracode" badge
  (struck through when the model does not support it). Each account
  remembers its model, mode and effort; after a reload an effort above High
  (Extra high, Max) starts at High again. A short note in the chat
  confirms a change; one made while Claude is not running applies when it
  starts. All menus open inside the panel. The header shows the status, the
  session's title, **New session** and **Session history**.
- Once half of the context is used, a line above the input shows how much is
  left before the CLI compacts the conversation; a compaction shows as a
  divider.
- **Session history** lists the recent Claude Code sessions of every account,
  in any folder, newest first, including the ones started with `claude` in a
  terminal (read from each account's `projects` folder), with the account
  and the folder of each. "Show older sessions" lists more. Picking one
  resumes it as its account, in the folder it was started in, and shows its
  earlier messages. Each entry can be archived (hidden from the list, in this
  panel only; "Show archived" lists them again) or deleted: after a
  confirmation the service removes its transcript and its folder from the
  account's `projects` folder. It
  refuses for the session open in the panel and for one open in another
  process, and it never follows a symbolic link. If the session is still open
  in another process (the CLI's
  records in `~/.claude/sessions`; without any, a transcript written in the
  last 2 minutes), the panel asks: **Open a copy** (`--fork-session`), **Open
  here anyway** or **Cancel**. The welcome screen still offers "Resume last
  session".
- Each answer ends with its cost and duration.

### From the editor

Right-click in the editor:

- **Ask Claude...** puts the selected code (or the current line) in the input
  box as a code block, after the file's path and line numbers: type your
  question and send it.
- **Fix with Claude**, on a line with an error or warning marker, puts the
  markers' messages and the line there.

In a terminal or a run's output, **Ask Claude About Selection** does the same
with the selected text. Nothing is sent until you press Enter; what is
already in the input box stays, before the new text. The path is relative to
the chat's folder when the file is in it, otherwise absolute. Both are
commands (`askclaude`, `fixwithclaude`) that can get a key in
Preferences > Keybindings.

### Accounts and folders

A line above the input shows where the next chat runs: its **account** (once
there is more than one) and its **folder**. Click it to change them; both are
fixed once the chat's first message is sent ("New session here" starts another
chat with the same ones).

- **Accounts** (Preferences > User Settings > Claude > Accounts). *Personal* is
  Claude Code as in a terminal (`~/.claude`, with `~/.claude.json`). **Add an
  account...** asks for a name and a folder in your home folder
  (`.claude-work`, `.claude-anything`): Claude Code keeps that account's
  login, settings, `.claude.json` and chats inside it (`CLAUDE_CONFIG_DIR`).
  **Log in...** opens a terminal running `claude` for that account: type
  `/login` there, then press **Check**. An account shares nothing unless you
  tick it: `CLAUDE.md` (an import line, `@~/.claude/CLAUDE.md`), `agents`,
  `commands`, `skills`, `output styles` (links to Personal's folders) and
  `settings.json` (a link: Claude reads it, but can't save settings through
  it from that account). Anything the account already has of its own is left
  alone. Removing an account from the list keeps its folder. An API key or
  token in the server's environment applies to Personal only.
- **Folders**: the workspace by default; a recent folder, **Choose folder...**
  (the folder dialog, which reaches folders outside the workspace through a
  link like `~/zoot -> /`), or a full path typed in. Right-click a folder in
  the file tree for **New Claude Chat Here**. Claude runs in that folder, so
  its `CLAUDE.md`, `.claude/settings.json` and "always allow" rules apply, and
  edits outside it need your approval.
- File names in the chat open in the editor when they are in the workspace,
  in the home folder, or under a link at the top of the workspace (the most
  specific link wins: `~/www -> /var/www` over `~/zoot -> /`).
- Two browser tabs on the same IDE each run their own chat at the same time.

If `claude` is not on the server's `PATH` (systemd services get a minimal one),
the panel also looks in `~/.local/bin`, `~/.claude/local`, `/usr/local/bin`,
`/usr/bin` and npm's global `bin`. You can set the full path in
Preferences > User Settings > Claude.

## How it works

- `claude.js`: the panel (plain DOM, styles in `claude.less` built into every
  skin). Markdown is rendered with remarkable (raw HTML off) and filtered
  through a whitelist (`markdown.js`); code is highlighted with Ace's
  tokenizers.
- `claude-service.js`: runs in the vfs process (`ext.loadRemotePlugin`). It
  spawns `claude -p --input-format stream-json --output-format stream-json
  --verbose --include-partial-messages --permission-prompt-tool stdio` with an
  argument list built from whitelisted values only, and relays its output.
  Permission answers, Stop (`interrupt`), the mode (`set_permission_mode`),
  the model (`set_model`), the effort and Ultracode (`apply_flag_settings`;
  at start `--effort` and `--settings {"ultracode":true}`), the model list
  (`list_models`) and the applied settings (`get_settings`) use the CLI's
  control messages. Changes are sent one at a
  time, in order.
- The account is passed as `CLAUDE_CONFIG_DIR` (not for Personal) and the
  folder as the working directory; the service checks both (a folder name in
  the home folder; an existing directory, by its real path).
- One CLI process per chat, started by the first message. It is stopped after
  20 minutes without activity (never in the middle of a turn), on New session,
  and when the IDE connection goes away; the next message resumes it with
  `--resume <session id>`.
- A CLI whose vfs process was killed with SIGKILL (for example by the OOM
  killer) is stopped by the next IDE connection, after checking that it really
  is that process (records in `~/.c9/claude-panel/`).

## Known limitations

- After such a SIGKILL, if the CLI has already exited by itself and has been
  reaped, commands it started (for example a long build run by the Bash tool)
  can keep running: their process group can no longer be identified safely,
  so they are left alone.
- The model list and the effort levels come from the CLI once it has run in
  the workspace; before that the panel offers Default, Opus, Sonnet and Haiku
  with Low, Medium and High.
- Messages from claude longer than 16 MB (a huge tool result) are not shown in
  the panel; Claude still gets them.

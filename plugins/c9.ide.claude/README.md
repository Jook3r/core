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
  elapsed time and "Esc to stop". Thinking shows as "Thinking... · 1.2k
  tokens", then "Thought for 6s". Set `localStorage["claude-debug"] = 1` in the
  browser console to log when each event arrives.
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
  it uses many more tokens). Ultracode is off by default; when on, the pill
  shows an "Ultracode" badge (struck through when the model does not support
  it). A short note in the chat
  confirms a change; one made while Claude is not running applies when it
  starts. All menus open inside the panel. The header shows the status, the
  session's title, **New session** and **Session history**.
- Once half of the context is used, a line above the input shows how much is
  left before the CLI compacts the conversation; a compaction shows as a
  divider.
- **Session history** lists the recent Claude Code sessions of this workspace,
  newest first, including the ones started with `claude` in a terminal, in the
  workspace or in a folder inside it (read from `~/.claude/projects`). Picking
  one resumes it in the folder it was started in and shows its earlier
  messages. Each entry can be archived (hidden from the list, in this panel
  only; "Show archived" lists them again) or deleted: after a confirmation the
  service removes its transcript and its folder from `~/.claude/projects`. It
  refuses for the session open in the panel and for one open in another
  process, and it never follows a symbolic link. If the session is still open
  in another process (the CLI's
  records in `~/.claude/sessions`; without any, a transcript written in the
  last 2 minutes), the panel asks: **Open a copy** (`--fork-session`), **Open
  here anyway** or **Cancel**. The welcome screen still offers "Resume last
  session".
- Each answer ends with its cost and duration.

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

# c9.ide.agent

The chat panel of the Claude panel (`c9.ide.claude`) and of the DeepSeek panel
(`c9.ide.deepseek`): one panel and one service, which each of the two plugins
uses with a *provider* of its own. Both run the user's `claude` CLI (Claude
Code); a provider says with which account and against which API.

What a user sees and does is in the two panels' own READMEs. This is for
changing the panels, or adding a third.

## Files

- `panel.js`: the panel in the browser. `createPanel(provider, options,
  imports, register)` builds it as the plugin `provider.id`.
- `panel.less`: its styles, under the `agent-` prefix; a provider's own
  colour and icon are at its end, under `.agent-<id>`.
- `service.js`: the server half, in the vfs process. It is loaded with
  `ext.loadRemotePlugin(<id>, { file: "c9.ide.agent/service.js", provider:
  <id> })`; its own table of providers (at its top) has what it needs about
  each. It starts the CLI and relays its stream; for a keyed provider it also
  keeps the API keys.
- `markdown.js`, `images.js`, `diff.js`: rendering of answers, attached
  images, the diffs of the Edit cards.
- `peak.js`: peak hours of a priced provider.
- `inline-edit.js`, `inline-edit-util.js`, `inline-edit.css`: the editor's
  inline edit (below).

## A provider

Two questions decide most of what differs:

- **keyed**: the CLI talks to another service's Anthropic-compatible API,
  with an API key of that service in place of the user's Claude login.
  Accounts are folders of the provider's own (never `~/.claude`), the key is
  kept on the server in the account's folder, and the server's Anthropic and
  Claude variables are kept out of the CLI's environment. The service then
  has `setApiKey`, `balance` and `complete`.
- **priced**: the models, their prices and peak hours are user settings; the
  panel estimates what an answer cost from its tokens. Otherwise the models
  are those the CLI reports and the cost is the CLI's own figure.

The object a panel's plugin passes (`claude.js` and `deepseek.js` are the two
examples):

| | |
|---|---|
| `id`, `name`, `product` | `"claude"`: the plugin, `user/claude` settings, the commands `askclaude`, `fixwithclaude`, `toggleclaude`. `"Claude"`: in the IDE's texts. `"Claude Code"`: in a few titles |
| `keyed`, `priced` | see above |
| `index`, `menu`, `prefsPosition`, `icon` | the panel's place among the panels, of its items in the menus and of its section in the preferences; its icon (one of `ICONS` in `panel.js`) |
| `accountName`, `accountDir` | the default account: its name in the panel and its folder in the home folder |
| `defaults` | the defaults of its user settings: `[["model", ...], ["effort", ...], ["mode", ...], ...]` |
| `autoEffort`, `maxEffortNote`, `maxEffortDesc`, `capEffort` | texts about the effort levels; whether a new tab starts at High at most |
| `loginRe`, `billingRe`, `installHelp` | what the CLI's errors look like when the login or key is not accepted, or there is no credit; the help when the CLI is not installed |
| `models`, `fastModel`, `peak`, `searchPrice` | priced: the models with their prices, the model for background tasks, the peak hours, the price of web searches |

For a third provider with an Anthropic-compatible API: a plugin like
`c9.ide.deepseek/deepseek.js` with its own provider object, an entry in the
table of `service.js` (the API's address, the names of the key file and of
the environment variables, the default models), its colour and icon at the
end of `panel.less`, and the plugin in `configs/ide/default.js`.

## Inline edit

Change code by saying what should change, and review the change in the
editor.

- Select the lines (or put the cursor where code should be added) and press
  **Ctrl-Alt-I**, or pick *Edit with AI…* in the editor's menu. A box opens
  under the lines; type the instruction and press Enter. Esc closes it.
- The answer is written into the box as it comes (Esc or *Stop* cancels
  it), and then replaces the lines in the editor. The new lines are marked
  green; the lines they replace are shown above them in red.
- Each change has **Keep** and **Undo** of its own, at the right. **Accept**
  (Ctrl-Enter, Cmd-Enter on a Mac) keeps what is left, **Reject**
  (Ctrl-Shift-Backspace) puts the old lines back. Another instruction in the
  box ("shorter", "use a loop") asks for a different answer to the same
  lines.
- Nothing is saved: the file is changed in the editor as by typing, one
  step to undo. Undo in the editor during a review takes the answer out and
  ends the review.
- An answer that is not an edit (a question, an instruction that is not
  clear) is shown as a note in the box, and nothing changes.

The box has the choice between Claude and DeepSeek; Preferences > General >
Inline Edit has it too, with the model (empty: a quick one, Sonnet or
DeepSeek Flash) and the effort. The edit runs with the account of that
panel's current chat and is billed like a short message there; the box
shows what it cost when the price is known.

What is sent: the instruction, the selected lines, and up to 400 lines
before and 120 after them (12 000 and 4 000 characters at most) for the
model to see where it is. Nothing else of the file or the workspace: the
model gets no tools for an edit.

How it works: `inline-edit.js` asks the panel's plugin (`edit()` in its
public API), which asks `edit()` of `service.js`. That runs the CLI once
(`claude -p` without tools, MCP servers, commands or a saved session, and a
system prompt of its own in place of Claude Code's) and passes its text on
as it is written. An API error that retrying cannot change (a key that is
not accepted, no balance) ends the edit at once, others after the third
attempt. `inline-edit-util.js` has what works on text only: taking the code
out of an answer (a model may still put it in a Markdown fence), giving it
the indentation of the lines it replaces, and finding the changes.

## Tests

`test/smoke.js` has a chat in each panel against a mock of the API (with what
each shows as the cost), Ask and Fix from the editor, an inline edit, and
DeepSeek's inline completions. `service_edit_test.js` runs the edit request
of the service with the CLI against a mock API (skipped without the CLI);
`inline-edit-util_test.js` tests the text functions.

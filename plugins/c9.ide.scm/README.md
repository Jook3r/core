# c9.ide.scm

Git in Cloud9: changed lines and blame in the code editor, and the Changes
panel. The configuration loads the plugins in `v1/`; the files directly in
this folder (`scm.js`, `scm.branches.js`, `git.js`, ...) are an unfinished
second version that isn't loaded, except `blame.js` and `diff/`, which `v1`
uses.

## In the code editor

`v1/gutter.js` marks the lines that differ from Git's staged version of the
file, what `git diff` shows, while you type: a green bar for added lines, a
blue bar for changed ones, and a red triangle where lines were deleted.

- **Goto > Next Change** and **Previous Change** move the cursor between
  them (wrapping around).
- Right-click the line numbers for **Revert Change** (the changed block
  under the mouse gets the staged lines back; Undo works) and **Show Git
  Blame**.
- The markers follow the index: after `git add` they disappear, as in
  `git diff`. They are refreshed when you switch to the tab, and when Git
  writes in `.git` (a commit, `git add`, a checkout, also from a terminal or
  by Claude).
- Turn them off in Preferences > User Settings > Code Editor (Ace) > Mark
  Changed Lines (Git).
- Files larger than 2 MB or 100,000 lines are not compared.

**Git blame** shows who last changed each line, with when and the commit's
summary, in a column left of the line numbers (hover for the commit, the
author's email and the date). It blames the text in the editor
(`git blame --contents -`), so unsaved and uncommitted lines show as "Not
committed yet", and it updates a second after you stop typing. Click a cell
to highlight the lines of that commit; drag the column's right edge to
resize it; × or the menu item hides it.

The commands (`gotonextchange`, `gotopreviouschange`, `revertchange`,
`blame`) have no keys; give them some in Preferences > Keybindings.

## The Changes panel

The Changes panel (left side) lists the modified, staged and untracked
files, with Commit (Ctrl-Enter in the message box; amend), Push, Pull and
Fetch, and the log below. It refreshes when files are saved and when Git
changes `.git` while it is open; Refresh does it by hand. The box at the top
is the folder of the repository, for one in a subfolder of the workspace.

The button on the right of the toolbar shows the checked out branch (or the
commit, "1a2b3c4 (detached)"). Click it for the branches, remote branches and
tags, with the last author and commit of each:

- Double-click a branch to switch to it. A remote branch (`origin/fix`)
  switches to the local branch `fix`, created to track it if there is none.
  A tag checks out its commit without a branch ("detached").
- **New Branch...** creates a branch from the current commit and switches to
  it.

Git's messages show at the top of the window when something fails: local
changes that a checkout would overwrite, a rejected push, "nothing to
commit", a missing `user.name`. Push, pull and fetch run without a terminal,
so Git can't ask for a password: use an SSH key or a credential helper for
HTTPS remotes (or push in a terminal).

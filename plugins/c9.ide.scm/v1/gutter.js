define(function(require, exports, module) {
    main.consumes = [
        "Plugin", "c9", "proc", "tabManager", "commands", "menus", "ui",
        "ace", "watcher", "util", "settings", "preferences", "MenuItem",
        "Divider", "dialog.error"
    ];
    main.provides = ["scm.gutter"];
    return main;

    /*
     * Git in the code editor: marks the lines that differ from the staged
     * version of the file (what `git diff` shows) while you edit, and shows
     * git blame next to the line numbers.
     */
    function main(options, imports, register) {
        var Plugin = imports.Plugin;
        var c9 = imports.c9;
        var proc = imports.proc;
        var tabs = imports.tabManager;
        var commands = imports.commands;
        var menus = imports.menus;
        var ui = imports.ui;
        var aceHandle = imports.ace;
        var watcher = imports.watcher;
        var util = imports.util;
        var settings = imports.settings;
        var prefs = imports.preferences;
        var MenuItem = imports.MenuItem;
        var Divider = imports.Divider;
        var showError = imports["dialog.error"].show;

        var basename = require("path").basename;
        var dirname = require("path").dirname;
        var dmp = require("../diff/diff_match_patch");
        var blame = require("../blame");
        var Range = require("ace/range").Range;

        /***** Initialization *****/

        var plugin = new Plugin("Ajax.org", main.consumes);

        // larger files are not compared
        var MAX_SIZE = 2000000;
        var MAX_LINES = 100000;
        var DIFF_DELAY = 300;
        var BLAME_DELAY = 1000;

        var enabled = false;
        var roots = Object.create(null); // folder: root of its repository
        var noRepo = Object.create(null); // folder: when git said it is in none
        var gitDirs = Object.create(null); // watched .git folder: root
        var repoTimers = Object.create(null);

        var loaded = false;
        function load() {
            if (loaded) return false;
            loaded = true;

            ui.insertCss(require("text!./gutter.css"), plugin);

            settings.on("read", function() {
                settings.setDefaults("user/scm", [["markChanges", true]]);
                setEnabled(settings.getBool("user/scm/@markChanges"));
            }, plugin);
            settings.on("user/scm/@markChanges", function() {
                setEnabled(settings.getBool("user/scm/@markChanges"));
            }, plugin);

            prefs.add({
                "Editors": {
                    position: 400,
                    "Code Editor (Ace)": {
                        position: 200,
                        "Mark Changed Lines (Git)": {
                            type: "checkbox",
                            position: 6300,
                            path: "user/scm/@markChanges"
                        }
                    }
                }
            }, plugin);

            tabs.on("tabAfterActivate", function(e) {
                refresh(e.tab, true);
            }, plugin);
            // e.g. back from a terminal that ran git commit
            tabs.on("focusSync", function(e) {
                refresh(e.tab, true);
            }, plugin);

            watcher.on("directory", onGitDir, plugin);
            watcher.on("change", onGitDir, plugin);

            commands.addCommand({
                name: "gotonextchange",
                group: "scm",
                hint: "go to the next line that differs from Git's staged version",
                isAvailable: hasChanges,
                exec: function(editor) { jump(editor.ace, 1); }
            }, plugin);
            commands.addCommand({
                name: "gotopreviouschange",
                group: "scm",
                hint: "go to the previous line that differs from Git's staged version",
                isAvailable: hasChanges,
                exec: function(editor) { jump(editor.ace, -1); }
            }, plugin);
            commands.addCommand({
                name: "revertchange",
                group: "scm",
                hint: "replace the changed lines at the cursor with Git's staged version",
                isAvailable: function(editor) {
                    return hasChanges(editor)
                        && !!hunkAt(editor.ace.session, editor.ace.getCursorPosition().row);
                },
                exec: function(editor) {
                    revert(editor.ace, editor.ace.getCursorPosition().row);
                }
            }, plugin);
            commands.addCommand({
                name: "blame",
                group: "scm",
                hint: "show or hide who last changed each line (git blame)",
                isAvailable: function(editor) {
                    return !!(editor && editor.ace && tabOf(editor.ace.session));
                },
                exec: function(editor) { toggleBlame(editor.ace); }
            }, plugin);

            menus.addItemByPath("Goto/Next Change", new ui.item({
                command: "gotonextchange"
            }), 650, plugin);
            menus.addItemByPath("Goto/Previous Change", new ui.item({
                command: "gotopreviouschange"
            }), 660, plugin);

            var gutterMenu;
            aceHandle.on("create", function() {
                if (gutterMenu) return;
                gutterMenu = aceHandle.gutterContextMenu;
                var meta = gutterMenu.meta;
                gutterMenu.append(new Divider({ position: 900 }, plugin));
                gutterMenu.append(new MenuItem({
                    caption: "Revert Change",
                    position: 910,
                    isAvailable: function() {
                        return !!(meta.ace && hunkAt(meta.ace.session, meta.line));
                    },
                    onclick: function() {
                        revert(meta.ace, meta.line);
                    }
                }, plugin));
                var blameItem = gutterMenu.append(new MenuItem({
                    position: 920,
                    isAvailable: function() {
                        var session = meta.ace && meta.ace.session;
                        blameItem.caption = session && session.$gitBlame
                            ? "Hide Git Blame"
                            : "Show Git Blame";
                        return !!(session && tabOf(session));
                    },
                    onclick: function() {
                        toggleBlame(meta.ace);
                    }
                }, plugin));
            }, plugin);
        }

        /***** Methods *****/

        function setEnabled(value) {
            if (enabled == value) return;
            enabled = value;
            tabs.getTabs().forEach(function(tab) {
                if (enabled) {
                    if (tab.isActive()) refresh(tab, true);
                }
                else {
                    var session = sessionOf(tab);
                    if (session && session.$gitChanges) {
                        session.$gitChanges.hunks = [];
                        decorate(session);
                    }
                }
            });
        }

        function sessionOf(tab) {
            if (!tab || tab.editorType != "ace" || !tab.path || !tab.document)
                return null;
            var c9Session = tab.document.getSession();
            return c9Session && c9Session.session || null;
        }

        function tabOf(session) {
            var tab = session && session.c9doc && session.c9doc.tab;
            return tab && tab.path && tab.editorType == "ace" ? tab : null;
        }

        // the absolute folder of a file of the IDE ("~/" works as a cwd)
        function folderOf(path) {
            var dir = dirname(path);
            if (dir.charAt(0) == "~") return dir;
            var ws = c9.workspaceDir.replace(/\/+$/, "");
            return ws + (dir == "/" ? "" : dir) || "/";
        }

        function refresh(tab, refetch) {
            var session = sessionOf(tab);
            if (!session || !enabled) return;

            var state = session.$gitChanges;
            if (!state) {
                state = session.$gitChanges = {
                    hunks: [],
                    decorations: [],
                    base: null,
                    stale: true,
                    generation: 0
                };
                session.on("change", function() {
                    refresh(tabOf(session), false);
                });
                tab.on("setPath", function() {
                    refresh(tab, true);
                }, plugin);
            }
            if (refetch) state.stale = true;

            clearTimeout(state.timer);
            state.timer = setTimeout(function() {
                update(tab, session, state);
            }, refetch ? 50 : DIFF_DELAY);
        }

        function update(tab, session, state) {
            // closed, or still loading (its value comes with a change)
            if (!enabled || sessionOf(tab) != session || !tab.document.hasValue())
                return;

            if (!state.stale)
                return mark(session, state);

            state.stale = false;
            var generation = ++state.generation;
            getStaged(tab.path, function(lines) {
                if (generation != state.generation) return;
                state.base = lines;
                mark(session, state);
            });
        }

        // the lines of the file in Git's index, or null
        function getStaged(path, callback) {
            var folder = folderOf(path);
            repoRoot(folder, function(root) {
                if (!root) return callback(null);
                proc.execFile("git", {
                    args: ["cat-file", "blob", ":./" + basename(path)],
                    cwd: folder,
                    maxBuffer: 4 * MAX_SIZE
                }, function(err, stdout) {
                    // not in the index (untracked, or a conflict)
                    if (err || stdout.length > MAX_SIZE)
                        return callback(null);
                    callback(stdout.split(/\r\n|\r|\n/));
                });
            });
        }

        function repoRoot(folder, callback) {
            if (roots[folder]) return callback(roots[folder]);
            // not in a repository, or no git: asked again after a while
            if (noRepo[folder] > Date.now() - 30000) return callback(null);
            proc.execFile("git", {
                args: ["rev-parse", "--show-toplevel"],
                cwd: folder
            }, function(err, stdout) {
                var root = !err && stdout.trim();
                if (root) {
                    roots[folder] = root;
                    watchRepo(root);
                }
                else
                    noRepo[folder] = Date.now();
                callback(root || null);
            });
        }

        // git add, commit, checkout... change files in .git
        function watchRepo(root) {
            var path = util.normalizePath(root + "/.git");
            // the watcher only reaches the workspace and the home folder
            if (path == root + "/.git" && c9.workspaceDir != "/") return;
            if (gitDirs[path]) return;
            gitDirs[path] = root;
            watcher.watch(path);
        }

        function onGitDir(e) {
            var root = gitDirs[e.path];
            if (!root) return;
            // git writes several files: once they are written
            clearTimeout(repoTimers[root]);
            repoTimers[root] = setTimeout(function() {
                tabs.getTabs().forEach(function(tab) {
                    var session = sessionOf(tab);
                    if (!session || roots[folderOf(tab.path)] != root) return;
                    if (session.$gitChanges) {
                        if (tab.isActive()) refresh(tab, true);
                        else session.$gitChanges.stale = true;
                    }
                    if (session.$gitBlame)
                        session.$gitBlame.reload();
                });
            }, 300);
        }

        function mark(session, state) {
            var lines = session.doc.getAllLines();
            state.hunks = enabled && state.base && lines.length <= MAX_LINES
                ? compare(state.base, lines) || []
                : [];
            decorate(session);
        }

        // the changed blocks of lines: { type, start, end } in the editor
        // and { baseStart, baseEnd } in the staged version (end excluded)
        function compare(base, lines) {
            var ids = Object.create(null);
            var count = 0;
            function encode(list) {
                var text = "";
                for (var i = 0; i < list.length; i++) {
                    var id = ids[list[i]];
                    if (id === undefined)
                        id = ids[list[i]] = count++;
                    text += String.fromCharCode(id);
                }
                return text;
            }
            // a character for each different line
            var a = encode(base);
            var b = encode(lines);
            if (count > 0xffff) return null;

            var differ = new dmp.diff_match_patch();
            var diffs = differ.diff_main(a, b, false);

            var hunks = [];
            var row = 0, baseRow = 0, added = 0, removed = 0;
            function flush() {
                if (added || removed) {
                    hunks.push({
                        type: !removed ? "added" : !added ? "deleted" : "modified",
                        start: row - added,
                        end: row,
                        baseStart: baseRow - removed,
                        baseEnd: baseRow
                    });
                }
                added = removed = 0;
            }
            diffs.forEach(function(diff) {
                var n = diff[1].length;
                if (diff[0] == dmp.DIFF_EQUAL) {
                    flush();
                    row += n;
                    baseRow += n;
                }
                else if (diff[0] == dmp.DIFF_DELETE) {
                    removed += n;
                    baseRow += n;
                }
                else {
                    added += n;
                    row += n;
                }
            });
            flush();
            return hunks;
        }

        function decorate(session) {
            var state = session.$gitChanges;
            var last = session.getLength() - 1;
            var list = [];
            state.hunks.forEach(function(hunk) {
                if (hunk.type != "deleted") {
                    for (var row = hunk.start; row < hunk.end; row++)
                        list.push([row, "c9-git-" + hunk.type]);
                }
                else if (hunk.start > last)
                    list.push([last, "c9-git-deleted-end"]);
                else
                    list.push([hunk.start, hunk.start ? "c9-git-deleted" : "c9-git-deleted-first"]);
            });

            var key = list.join(";");
            if (key == state.key) return;
            state.key = key;

            state.decorations.forEach(function(item) {
                session.removeGutterDecoration(item[0], item[1]);
            });
            list.forEach(function(item) {
                session.addGutterDecoration(item[0], item[1]);
            });
            state.decorations = list;
        }

        function hasChanges(editor) {
            var state = editor && editor.ace && editor.ace.session.$gitChanges;
            return !!(enabled && state && state.hunks.length);
        }

        // the changed block shown on a row: a deletion shows on the row
        // after it (the last row at the end of the file)
        function hunkAt(session, row) {
            var state = session.$gitChanges;
            if (!enabled || !state) return null;
            var last = session.getLength() - 1;
            return state.hunks.filter(function(hunk) {
                var start = Math.min(hunk.start, last);
                var end = hunk.type == "deleted" ? start + 1 : hunk.end;
                return row >= start && row < end;
            })[0] || null;
        }

        function jump(ace, direction) {
            var session = ace.session;
            var hunks = session.$gitChanges ? session.$gitChanges.hunks : [];
            if (!hunks.length) return;
            var row = ace.getCursorPosition().row;
            var current = hunkAt(session, row);
            var target;
            if (direction > 0) {
                var after = current ? Math.max(current.end - 1, current.start) : row;
                target = hunks.filter(function(hunk) {
                    return hunk.start > after;
                })[0] || hunks[0];
            }
            else {
                var before = current ? current.start : row;
                target = hunks.filter(function(hunk) {
                    return hunk.start < before;
                }).pop() || hunks[hunks.length - 1];
            }
            var targetRow = Math.min(target.start, session.getLength() - 1);
            ace.selection.clearSelection();
            ace.selection.moveTo(targetRow, 0);
            ace.renderer.scrollCursorIntoView(null, 0.5);
            ace.focus();
        }

        function revert(ace, row) {
            var session = ace.session;
            var hunk = hunkAt(session, row);
            if (!hunk) return;
            var doc = session.doc;
            var lines = session.$gitChanges.base.slice(hunk.baseStart, hunk.baseEnd);
            if (hunk.type == "added")
                doc.removeFullLines(hunk.start, hunk.end - 1);
            else if (hunk.type == "deleted")
                doc.insertFullLines(hunk.start, lines);
            else {
                var lastRow = hunk.end - 1;
                doc.replace(new Range(hunk.start, 0, lastRow, doc.getLine(lastRow).length),
                    lines.join(doc.getNewLineCharacter()));
            }
            ace.selection.clearSelection();
            ace.selection.moveTo(Math.min(hunk.start, session.getLength() - 1), 0);
            ace.focus();
        }

        function toggleBlame(ace) {
            var session = ace.session;
            if (session.$gitBlame)
                return closeBlame(session);

            var state = session.$gitBlame = {
                timer: null,
                reload: function() {
                    clearTimeout(state.timer);
                    state.timer = setTimeout(run, BLAME_DELAY);
                }
            };
            session.on("change", state.reload);
            run();

            function run() {
                var tab = tabOf(session);
                if (!tab) return closeBlame(session);
                getBlame(tab.path, session.getValue(), function(err, data) {
                    if (session.$gitBlame != state) return;
                    if (err) {
                        // e.g. the file was renamed: no message then
                        var first = !state.gutter;
                        closeBlame(session);
                        if (first) showError(blameError(tab.path, err));
                        return;
                    }
                    if (!state.gutter) {
                        // another tab of the pane is shown now
                        if (ace.session != session) return closeBlame(session);
                        state.gutter = blame.annotate(ace);
                        state.gutter.onClose = function() {
                            state.gutter = null;
                            closeBlame(session);
                        };
                    }
                    state.gutter.setData(data);
                });
            }
        }

        function closeBlame(session) {
            var state = session.$gitBlame;
            if (!state) return;
            session.$gitBlame = null;
            clearTimeout(state.timer);
            session.off("change", state.reload);
            if (state.gutter)
                state.gutter.removeData();
        }

        // blame of the editor's text, so edits show as "Not committed yet"
        function getBlame(path, value, callback) {
            proc.spawn("git", {
                args: ["blame", "-wp", "--contents", "-", "--", basename(path)],
                cwd: folderOf(path)
            }, function(err, process) {
                if (err) return callback(err);
                var stdout = "", stderr = "";
                process.stdout.on("data", function(chunk) { stdout += chunk; });
                process.stderr.on("data", function(chunk) { stderr += chunk; });
                // after the output (unlike "exit")
                process.on("close", function(code) {
                    if (code) return callback(new Error(stderr.trim() || "git blame exited with " + code));
                    callback(null, stdout);
                });
                process.stdin.write(value);
                process.stdin.end();
            });
        }

        function blameError(path, err) {
            var message = String(err.message || err).replace(/^fatal: /, "");
            var name = basename(path);
            if (/not a git repository/.test(message))
                return "Git blame: " + name + " is not in a Git repository.";
            if (/no such path/.test(message))
                return "Git blame: " + name + " is not committed yet.";
            if (err.code == "ENOENT")
                return "Git blame needs git, which is not installed on the server.";
            return "Git blame of " + name + " failed: " + message;
        }

        /***** Lifecycle *****/

        plugin.on("load", function() {
            load();
        });
        plugin.on("unload", function() {
            loaded = false;
            enabled = false;
            roots = Object.create(null);
            noRepo = Object.create(null);
            gitDirs = Object.create(null);
        });

        /***** Register and define API *****/

        /**
         * Marks the lines that differ from Git's staged version of the
         * file in the gutter of the code editor, and shows git blame.
         */
        plugin.freezePublicAPI({
            /**
             * The changed blocks of lines of an Ace session
             * @param {EditSession} session
             * @return {Array} { type: "added"|"modified"|"deleted",
             *   start, end, baseStart, baseEnd } (rows, end excluded)
             */
            getChanges: function(session) {
                return session.$gitChanges ? session.$gitChanges.hunks.slice() : [];
            },

            /**
             * Shows or hides git blame in an Ace editor
             * @param {Editor} ace
             */
            toggleBlame: toggleBlame
        });

        register(null, {
            "scm.gutter": plugin
        });
    }
});

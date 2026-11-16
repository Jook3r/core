/**
 * Claude Code IDE bridge: Cloud9 as the editor of the `claude` CLI.
 *
 * A `claude` started in one of Cloud9's terminals connects to the IDE, as it
 * does to VS Code (/ide in the CLI shows the connection). It then
 *
 *  - knows the file and the selection of the focused editor, which go along
 *    with a prompt ("fix this"),
 *  - shows a change it proposes as a two-sided diff in a tab, to accept
 *    (also after editing the proposed side) or reject, next to its question
 *    in the terminal,
 *  - reads the markers the editor shows for a file, and is told about the
 *    ones its own edit caused,
 *  - can be handed a reference to the selected lines (the command "Mention
 *    the Selection in Claude Code").
 *
 * The server half, ide-service.js, runs in the vfs process: it is what the
 * CLI connects to, and relays between the CLI and this plugin. This half
 * answers with what only the IDE in the browser knows.
 */
define(function(require, exports, module) {
    "use strict";

    main.consumes = [
        "Plugin", "c9", "ext", "settings", "preferences", "tabManager",
        "commands", "menus", "fs", "save", "ui"
    ];
    main.provides = ["claude.ide"];
    return main;

    function main(options, imports, register) {
        var Plugin = imports.Plugin;
        var c9 = imports.c9;
        var ext = imports.ext;
        var settings = imports.settings;
        var prefs = imports.preferences;
        var tabManager = imports.tabManager;
        var commands = imports.commands;
        var menus = imports.menus;
        var fs = imports.fs;
        var save = imports.save;
        var ui = imports.ui;

        var plugin = new Plugin("Ajax.org", main.consumes);
        var emit = plugin.getEmitter();

        /***** Constants *****/

        var ALIVE_INTERVAL = 25000;     // the service is told this often that the IDE is there
        var SELECTION_DELAY = 150;      // the selection is sent this long after it changed (ms)
        var MAX_SELECTION = 200000;     // and at most this much of its text
        var SETTING = "user/claude/@ide";
        var SEVERITY = { error: "Error", warning: "Warning", info: "Info" };

        /***** State *****/

        var api = null;                 // the remote service
        var stream = null;
        var connecting = false;
        var clients = 0;                // connected CLIs
        var diffs = {};                 // open diffs by the id of their tool call
        var latestSelection = null;     // the last selection of an editor that had the focus
        var selectionTimer = null;
        var watchedAce = null;
        var loaded = false;
        var aliveTimer = null;

        /***** Paths *****/

        function trimSlash(dir) {
            return String(dir || "").replace(/\/+$/, "");
        }

        // The path of a file as the CLI has it, for a path of the editor
        // ("/src/a.js" in the workspace, "~/notes.md" in the home folder)
        function absolutePath(path) {
            path = String(path || "");
            if (/^~(\/|$)/.test(path)) {
                var home = trimSlash(c9.home);
                return home ? home + path.slice(1) : null;
            }
            if (path.charAt(0) != "/") return null;
            return trimSlash(c9.workspaceDir) + path;
        }

        // The path the editor opens a file by; null for a file outside the
        // workspace and the home folder, which the editor can't open
        function editorPath(abs) {
            abs = String(abs || "").replace(/^file:\/\//, "");
            if (abs.charAt(0) != "/" || /(^|\/)\.\.(\/|$)/.test(abs)) return null;
            var ws = trimSlash(c9.workspaceDir);
            if (abs == ws) return "/";
            if (abs.indexOf(ws + "/") === 0) return abs.slice(ws.length);
            var home = trimSlash(c9.home);
            if (home && abs.indexOf(home + "/") === 0) return "~" + abs.slice(home.length);
            return null;
        }

        /***** The remote service *****/

        // on, unless the user turned it off (also before the settings and
        // their defaults are read)
        function enabled() {
            var value = settings.get(SETTING);
            return value !== false && value !== "false";
        }

        function loadRemote(useCode) {
            if (connecting || api || !enabled() || !c9.connected) return;
            connecting = true;
            ext.loadRemotePlugin("claudeide", {
                file: useCode ? undefined : "c9.ide.claude/ide-service.js",
                code: useCode ? require("text!./ide-service.js") : undefined
            }, function(err, remote) {
                connecting = false;
                // loaded already in this vfs (a reconnect): its API comes
                // with the error. No API: the vfs can't read the file (a
                // remote workspace), so send the code.
                if (!remote && !useCode)
                    return loadRemote(true);
                if (!remote)
                    return console.error("[claude ide] could not load the service", err);
                if (!enabled())
                    return remote.stop(function() {});
                connecting = true;
                remote.connect(function(err, meta) {
                    connecting = false;
                    if (err || !meta || !meta.stream)
                        return console.error("[claude ide] could not start", err);
                    api = remote;
                    stream = meta.stream;
                    setClients(meta.clients || 0);
                    stream.on("data", function(chunk) {
                        var event;
                        try {
                            event = JSON.parse(chunk);
                        } catch (e) {
                            return;
                        }
                        try {
                            onEvent(event);
                        } catch (e) {
                            console.error("[claude ide] event failed", event && event.ev, e);
                        }
                    });
                    var gone = function() {
                        if (stream !== meta.stream) return;
                        stream = api = null;
                        setClients(0);
                        closeDiffs();
                    };
                    stream.on("end", gone);
                    stream.on("close", gone);
                    emit("ready", { port: meta.port });
                });
            });
        }

        function unloadRemote() {
            var remote = api;
            api = stream = null;
            setClients(0);
            closeDiffs();
            if (remote) remote.stop(function() {});
        }

        function setClients(count) {
            if (clients == count) return;
            clients = count;
            emit("clients", { count: count });
        }

        function onEvent(event) {
            switch (event.ev) {
                case "clients":
                    return setClients(event.count);
                case "connected":
                    // a CLI that has just connected: what is selected now
                    return sendSelection(true);
                case "call":
                    return onCall(event);
                case "cancel":
                    // the CLI no longer waits for the answer
                    if (diffs[event.id]) closeDiff(diffs[event.id]);
                    return;
            }
        }

        /***** The selection *****/

        function aceOf(tab) {
            return tab && tab.editorType == "ace" && tab.path && tab.editor && tab.editor.ace || null;
        }

        function selectionOf(tab) {
            var ace = aceOf(tab);
            var abs = ace && absolutePath(tab.path);
            if (!abs) return null;
            var range = ace.getSelectionRange();
            var text = ace.session.getTextRange(range);
            if (text.length > MAX_SELECTION) text = text.slice(0, MAX_SELECTION);
            return {
                text: text,
                filePath: abs,
                fileUrl: "file://" + abs,
                selection: {
                    start: { line: range.start.row, character: range.start.column },
                    end: { line: range.end.row, character: range.end.column },
                    isEmpty: range.isEmpty()
                }
            };
        }

        function sendSelection(now) {
            clearTimeout(selectionTimer);
            if (!now) {
                selectionTimer = setTimeout(function() { sendSelection(true); }, SELECTION_DELAY);
                return;
            }
            var selection = selectionOf(tabManager.focussedTab);
            if (!selection) return;
            latestSelection = selection;
            if (api && clients) api.notify("selection_changed", selection, function() {});
        }

        function onSelectionChange() {
            sendSelection(false);
        }

        // Follows the selection of the editor that has the focus
        function watchFocussedTab() {
            var ace = aceOf(tabManager.focussedTab);
            if (ace !== watchedAce) {
                if (watchedAce) watchedAce.off("changeSelection", onSelectionChange);
                watchedAce = ace;
                if (ace) ace.on("changeSelection", onSelectionChange);
            }
            if (ace) sendSelection(false);
        }

        /***** Tool calls of a CLI *****/

        function text(value) {
            return [{ type: "text", text: typeof value == "string" ? value : JSON.stringify(value) }];
        }

        function onCall(call) {
            var args = call.args || {};
            function answer(err, content) {
                if (api) api.respond(call.id, err ? String(err.message || err) : null, content, function() {});
            }
            switch (call.tool) {
                case "openDiff":
                    return openDiff(call, args, answer);
                case "close_tab":
                    Object.keys(diffs).forEach(function(id) {
                        if (diffs[id].name === args.tab_name) closeDiff(diffs[id]);
                    });
                    return answer(null, text("TAB_CLOSED"));
                case "closeAllDiffTabs":
                    var count = 0;
                    Object.keys(diffs).forEach(function(id) {
                        if (diffs[id].client === call.client) {
                            closeDiff(diffs[id]);
                            count++;
                        }
                    });
                    return answer(null, text("CLOSED_" + count + "_DIFF_TABS"));
                case "getDiagnostics":
                    return answer(null, text(diagnostics(args.uri)));
                case "getCurrentSelection":
                    var current = selectionOf(tabManager.focussedTab);
                    return answer(null, text(current
                        ? assign({ success: true }, current)
                        : { success: false, message: "No active editor found" }));
                case "getLatestSelection":
                    return answer(null, text(latestSelection
                        ? assign({ success: true }, latestSelection)
                        : { success: false, message: "No selection available" }));
                case "getOpenEditors":
                    return answer(null, text({ tabs: openEditors() }));
                case "openFile":
                    return openFile(args, answer);
                case "checkDocumentDirty":
                    var tab = tabOf(args.filePath);
                    return answer(null, text(tab
                        ? { success: true, filePath: args.filePath, isDirty: !!tab.document.changed, isUntitled: false }
                        : { success: false, message: "Document not open: " + args.filePath }));
                case "saveDocument":
                    return saveDocument(args, answer);
                default:
                    return answer("Unknown tool: " + call.tool);
            }
        }

        function assign(target, source) {
            for (var key in source) target[key] = source[key];
            return target;
        }

        function tabOf(abs) {
            var path = editorPath(abs);
            return path ? tabManager.findTab(path) : null;
        }

        function aceTabs() {
            return tabManager.getTabs().filter(function(tab) {
                return tab.editorType == "ace" && tab.path;
            });
        }

        function openEditors() {
            var focussed = tabManager.focussedTab;
            return aceTabs().map(function(tab) {
                var abs = absolutePath(tab.path);
                return abs && {
                    uri: "file://" + abs,
                    isActive: tab === focussed,
                    label: tab.title,
                    isDirty: !!tab.document.changed
                };
            }).filter(Boolean);
        }

        // The markers of the files that are open in the editor: of one file
        // (uri), or of all. [{ uri, diagnostics: [...] }]
        function diagnostics(uri) {
            var only = uri ? editorPath(uri) : null;
            if (uri && !only) return [];
            var result = [];
            aceTabs().forEach(function(tab) {
                if (only && tab.path !== only) return;
                var abs = absolutePath(tab.path);
                var session = tab.document.getSession();
                var aceSession = session && session.session;
                if (!abs || !aceSession) return;
                var list = (aceSession.getAnnotations() || []).map(function(a) {
                    var message = String(a.text || "").trim();
                    if (!message) return null;
                    var position = { line: a.row || 0, character: a.column || 0 };
                    return {
                        message: message,
                        severity: SEVERITY[a.type] || "Info",
                        source: "Cloud9",
                        range: { start: position, end: position }
                    };
                }).filter(Boolean);
                if (list.length || only)
                    result.push({ uri: "file://" + abs, diagnostics: list });
            });
            return result;
        }

        function openFile(args, answer) {
            var path = editorPath(args.filePath);
            if (!path)
                return answer("Cloud9 can only open files of the workspace and the home folder: " + args.filePath);
            tabManager.open({ path: path, focus: args.makeFrontmost !== false, active: true }, function(err, tab) {
                if (err) return answer("Could not open " + args.filePath + ": " + (err.message || err));
                var ace = aceOf(tab);
                if (ace && typeof args.startText == "string" && args.startText) {
                    var value = ace.session.getValue();
                    var from = value.indexOf(args.startText);
                    if (from != -1) {
                        var to = from + args.startText.length;
                        if (typeof args.endText == "string" && args.endText) {
                            var end = value.indexOf(args.endText, to);
                            if (end != -1) to = end + args.endText.length;
                        }
                        var doc = ace.session.doc;
                        var range = { start: doc.indexToPosition(from, 0), end: doc.indexToPosition(to, 0) };
                        if (args.selectToEndOfLine)
                            range.end.column = ace.session.getLine(range.end.row).length;
                        ace.selection.setSelectionRange(range);
                        ace.centerSelection();
                    }
                }
                answer(null, text("Opened file: " + args.filePath));
            });
        }

        function saveDocument(args, answer) {
            var tab = tabOf(args.filePath);
            if (!tab)
                return answer(null, text({ success: false, message: "Document not open: " + args.filePath }));
            save.save(tab, {}, function(err) {
                answer(null, text(err
                    ? { success: false, message: String(err.message || err) }
                    : { success: true, filePath: args.filePath, saved: true }));
            });
        }

        /***** Diffs *****/

        // The contents the proposed ones are compared with: what the editor
        // has, if the file is open (unsaved changes show), else the file's;
        // "" for a file that does not exist yet
        function currentContents(path, callback) {
            var tab = tabManager.findTab(path);
            if (tab && tab.editorType == "ace" && tab.document && typeof tab.document.value == "string")
                return callback(tab.document.value);
            fs.readFile(path, function(err, data) {
                callback(err ? "" : String(data));
            });
        }

        function openDiff(call, args, answer) {
            var path = editorPath(args.old_file_path || args.new_file_path);
            if (!path || typeof args.new_file_contents != "string")
                return answer("Cloud9 can't show a diff of " + (args.old_file_path || args.new_file_path));
            var name = String(args.tab_name || path);
            var fileName = path.split("/").pop();
            var diff = diffs[call.id] = { id: call.id, client: call.client, name: name, tab: null, settled: false };

            // Answers the CLI once: FILE_SAVED with the contents to write
            // (the CLI writes the file), or DIFF_REJECTED
            function settle(accepted, contents) {
                if (diff.settled) return;
                diff.settled = true;
                answer(null, accepted
                    ? [{ type: "text", text: "FILE_SAVED" }, { type: "text", text: contents }]
                    : [{ type: "text", text: "DIFF_REJECTED" }, { type: "text", text: name }]);
                closeDiff(diff);
            }
            diff.settle = settle;

            currentContents(path, function(orig) {
                if (diff.settled || !diffs[call.id]) return;
                tabManager.open({
                    editorType: "diffview",
                    focus: true,
                    active: true,
                    document: {
                        // not a tab to restore when the IDE is opened again
                        meta: { ignoreState: true },
                        diffview: {
                            oldPath: path,
                            newPath: path,
                            diff: { orig: orig, edit: args.new_file_contents, editable: true },
                            labels: {
                                left: fileName + " - now",
                                right: fileName + " - proposed by Claude (you can edit it)",
                                title: "✻ " + fileName
                            },
                            actions: [{
                                caption: "Accept",
                                "class": "claude-diff-accept",
                                onclick: function(diffview) {
                                    settle(true, diffview.edit.session.getValue());
                                }
                            }, {
                                caption: "Reject",
                                "class": "claude-diff-reject",
                                onclick: function() {
                                    settle(false);
                                }
                            }]
                        }
                    }
                }, function(err, tab) {
                    if (err || !tab) {
                        delete diffs[call.id];
                        return diff.settled || answer("Could not open the diff: " + (err && err.message || err));
                    }
                    // answered or cancelled while the tab was opening
                    if (diff.settled || !diffs[call.id])
                        return tab.close();
                    diff.tab = tab;
                    // closing the tab is a "no"
                    tab.on("close", function() {
                        diff.tab = null;
                        settle(false);
                    });
                });
            });
        }

        // Closes a diff's tab without an answer of its own: the CLI has one
        // already or no longer waits for it
        function closeDiff(diff) {
            delete diffs[diff.id];
            diff.settled = true;
            var tab = diff.tab;
            diff.tab = null;
            if (tab) tab.close();
        }

        function closeDiffs() {
            Object.keys(diffs).forEach(function(id) {
                closeDiff(diffs[id]);
            });
        }

        /***** Mention *****/

        // Hands the CLI a reference to the selected lines of the focused
        // editor (it appears in its prompt as @file#L1-5)
        function mention() {
            var tab = tabManager.focussedTab;
            var selection = selectionOf(tab);
            if (!selection || !api || !clients) return false;
            var params = { filePath: selection.filePath };
            if (!selection.selection.isEmpty) {
                params.lineStart = selection.selection.start.line;
                // a selection that ends at the start of a line does not
                // include that line
                var end = selection.selection.end;
                params.lineEnd = end.character === 0 && end.line > params.lineStart ? end.line - 1 : end.line;
            }
            api.notify("at_mentioned", params, function() {});
            return true;
        }

        /***** Lifecycle *****/

        plugin.on("load", function() {
            if (loaded) return;
            loaded = true;

            settings.on("read", function() {
                settings.setDefaults("user/claude", [["ide", "true"]]);
                if (enabled()) loadRemote();
            }, plugin);
            settings.on(SETTING, function() {
                if (enabled()) loadRemote();
                else unloadRemote();
            }, plugin);

            prefs.add({
                "General": {
                    "Claude": {
                        "Connect Claude Code in a Terminal to the Editor (selection, diffs, markers)": {
                            type: "checkbox",
                            path: SETTING,
                            position: 150
                        }
                    }
                }
            }, plugin);

            commands.addCommand({
                name: "claudemention",
                hint: "hand the selected lines to Claude Code in a terminal, as a reference",
                bindKey: { mac: "Command-Option-K", win: "Ctrl-Alt-K" },
                isAvailable: function() {
                    return !!(api && clients && aceOf(tabManager.focussedTab));
                },
                exec: function() {
                    mention();
                }
            }, plugin);
            menus.addItemByPath("Tools/Mention the Selection in Claude Code", new ui.item({
                command: "claudemention"
            }), 1250, plugin);

            c9.on("connect", function() {
                // connected (again): the service of this connection's vfs
                loadRemote();
            }, plugin);
            c9.on("disconnect", function() {
                api = stream = null;
                connecting = false;
                setClients(0);
                closeDiffs();
            }, plugin);

            // (connected already, and the settings read, when this plugin
            // is loaded late)
            loadRemote();

            tabManager.on("focus", watchFocussedTab, plugin);
            tabManager.on("tabAfterActivate", watchFocussedTab, plugin);

            // the IDE that is used has the lock file (see ide-service.js),
            // one that is gone has none
            window.addEventListener("focus", onWindowFocus);
            aliveTimer = setInterval(function() {
                if (api) api.alive(function() {});
            }, ALIVE_INTERVAL);
        });

        function onWindowFocus() {
            if (api) api.activate(function() {});
        }

        plugin.on("unload", function() {
            window.removeEventListener("focus", onWindowFocus);
            clearInterval(aliveTimer);
            clearTimeout(selectionTimer);
            if (watchedAce) watchedAce.off("changeSelection", onSelectionChange);
            watchedAce = null;
            unloadRemote();
            loaded = false;
        });

        /***** Register and define API *****/

        plugin.freezePublicAPI({
            /**
             * The number of `claude` CLIs that are connected
             * @property {Number} clients
             */
            get clients() { return clients; },

            /**
             * Whether the bridge is running
             * @property {Boolean} ready
             */
            get ready() { return !!api; },

            /**
             * Hands the connected CLIs a reference to the selected lines of
             * the focused editor.
             * @return {Boolean} false without an editor or a connected CLI
             */
            mention: mention,

            _events: [
                /** @event ready    the bridge is running */
                "ready",
                /** @event clients  a CLI connected or went away */
                "clients"
            ]
        });

        register(null, { "claude.ide": plugin });
    }
});

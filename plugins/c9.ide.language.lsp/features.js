/**
 * What the IDE shows of a language server (see ./lsp.js), beyond what the
 * language worker asks of it by itself:
 *
 *  - a tooltip for what the mouse rests on: its type and documentation
 *  - Find References, Go to Type Definition, Go to Implementation: a list of
 *    places, each with its line, to go to
 *  - Rename Symbol: in every file of the project that uses it
 *  - Quick Fix: the server's fixes and refactorings for the cursor's place or
 *    the selection (add a missing import, organize the imports, ...)
 *  - Format Document
 *
 * Each asks the client in the worker ("lsp_request", with the document's
 * text as it is now) and gets an "lsp_response". Changes come as lists of
 * edits per file: files that are open are changed in the editor (and can be
 * undone there), the others on disk.
 */
define(function(require, exports, module) {
    "use strict";

    main.consumes = [
        "Plugin", "language.lsp", "tabManager", "commands", "menus", "ui", "fs",
        "ace", "settings", "dialog.error"
    ];
    main.provides = ["language.lsp.features"];
    return main;

    function main(options, imports, register) {
        var Plugin = imports.Plugin;
        var lsp = imports["language.lsp"];
        var tabManager = imports.tabManager;
        var commands = imports.commands;
        var menus = imports.menus;
        var ui = imports.ui;
        var fs = imports.fs;
        var aceHandle = imports.ace;
        var settings = imports.settings;
        var showError = imports["dialog.error"].show;

        var Range = require("ace/range").Range;

        var plugin = new Plugin("Ajax.org", main.consumes);

        /***** Constants *****/

        var REQUEST_TIMEOUT = 20000;
        var HOVER_DELAY = 350;          // the mouse rests this long before a tooltip (ms)
        var HOVER_MAX = 6000;           // characters of a tooltip
        var PREVIEW_FILES = 40;         // files read for the lines of a list of places
        var PREVIEW_LENGTH = 160;

        /***** State *****/

        var nextId = 1;
        var pending = {};               // request id -> callback
        var boundHandler = null;
        var hover = null;               // { el, ace, range } while a tooltip shows
        var hoverTimer = null;
        var hoverSeq = 0;
        var hoverTab = null;            // the tab the mouse is over
        var popup = null;               // the open list or rename box
        var dark = true;
        var loaded = false;

        /***** Requests *****/

        function bind() {
            var handler = lsp.handler;
            if (!handler || handler === boundHandler) return;
            boundHandler = handler;
            handler.on("lsp_response", function(e) {
                var callback = pending[e.id];
                if (!callback) return;
                delete pending[e.id];
                callback(e.err ? new Error(e.err) : null, e.result);
            });
            // what a command of a code action changes
            handler.on("lsp_apply_edit", function(e) {
                applyEdit(e, function() {});
            });
        }

        function aceTab(tab) {
            tab = tab || tabManager.focussedTab;
            return tab && tab.editorType == "ace" && tab.path && tab.editor && tab.editor.ace ? tab : null;
        }

        // Asks the client in the worker about a tab's document.
        // callback(err, result)
        function request(type, tab, extra, callback) {
            bind();
            if (!boundHandler) return callback(new Error("The language worker is not ready yet"));
            var ace = tab.editor.ace;
            var id = nextId++;
            var message = { id: id, type: type, path: tab.path, value: ace.getValue(), pos: ace.getCursorPosition() };
            for (var key in extra) message[key] = extra[key];
            var timer = setTimeout(function() {
                if (!pending[id]) return;
                delete pending[id];
                callback(new Error("The language server did not answer"));
            }, REQUEST_TIMEOUT);
            pending[id] = function(err, result) {
                clearTimeout(timer);
                callback(err, result);
            };
            boundHandler.emit("lsp_request", message);
        }

        // A message at the cursor that goes away by itself
        function flash(tab, text) {
            var ace = tab.editor.ace;
            var at = ace.renderer.textToScreenCoordinates(ace.getCursorPosition().row, ace.getCursorPosition().column);
            var el = element("div", "language_tooltip lsp-flash" + (dark ? " dark" : ""), text);
            document.body.appendChild(el);
            place(el, at.pageX, at.pageY, ace.renderer.lineHeight);
            setTimeout(function() {
                if (el.parentNode) el.parentNode.removeChild(el);
            }, 2500);
        }

        function element(tag, className, text) {
            var el = document.createElement(tag);
            if (className) el.className = className;
            if (text != null) el.textContent = text;
            return el;
        }

        // Below the line at (x, y), or above it where there is no room;
        // inside the window
        function place(el, x, y, lineHeight) {
            var width = el.offsetWidth, height = el.offsetHeight;
            var left = Math.max(4, Math.min(x, window.innerWidth - width - 8));
            var top = y + lineHeight + 2;
            if (top + height > window.innerHeight - 4 && y - height - 2 > 0)
                top = y - height - 2;
            el.style.left = left + "px";
            el.style.top = top + "px";
        }

        /***** Hover *****/

        function attach(editor) {
            var ace = editor.ace;
            if (!ace || ace.$lspHover) return;
            ace.$lspHover = true;
            ace.on("mousemove", function(e) {
                onMouseMove(editor, e);
            });
            var hide = function() { hideHover(); };
            ace.on("mousedown", hide);
            ace.on("mousewheel", hide);
            ace.on("change", hide);
            ace.on("blur", hide);
            ace.container.addEventListener("mouseleave", function(e) {
                // (not when the mouse goes to the tooltip itself)
                if (hover && e.relatedTarget && hover.el.contains(e.relatedTarget)) return;
                hideHover();
            });
        }

        function onMouseMove(editor, e) {
            var ace = editor.ace;
            if (hover && hover.ace === ace) {
                var at = e.getDocumentPosition();
                if (hover.range.contains(at.row, at.column)) return;
            }
            clearTimeout(hoverTimer);
            if (!settings.getBool("user/lsp/@hover") || e.domEvent.buttons || popup)
                return hideHover();
            var x = e.clientX, y = e.clientY;
            hoverTab = tabManager.focussedTab;
            hoverTimer = setTimeout(function() {
                showHover(editor, x, y);
            }, HOVER_DELAY);
            if (hover) hideHover(true);
        }

        // The word under (x, y), if there is one: { row, start, end }
        function wordAt(ace, x, y) {
            var renderer = ace.renderer;
            var pos = renderer.screenToTextCoordinates(x, y);
            var line = ace.session.getLine(pos.row);
            // right of the line's end, or below the last line
            var end = renderer.textToScreenCoordinates(pos.row, line.length);
            if (x > end.pageX + renderer.characterWidth || y > end.pageY + renderer.lineHeight) return null;
            var range = ace.session.getWordRange(pos.row, pos.column);
            var word = line.slice(range.start.column, range.end.column);
            if (!/[\w$]/.test(word)) return null;
            return { row: pos.row, start: range.start.column, end: range.end.column };
        }

        function showHover(editor, x, y) {
            var tab = tabManager.focussedTab;
            var ace = editor.ace;
            if (!tab || tab.editor !== editor || !aceTab(tab) || !lsp.handles(tab.path)) return;
            if (!ace.selection.isEmpty() || document.querySelector(".ace_autocomplete[style*='display: block']")) return;
            var word = wordAt(ace, x, y);
            if (!word) return;
            var seq = ++hoverSeq;
            request("hover", tab, { pos: { row: word.row, column: word.start + 1 > word.end ? word.start : word.start + 1 } }, function(err, result) {
                if (err || !result || seq != hoverSeq || tabManager.focussedTab !== tab) return;
                var el = element("div", "language_tooltip lsp-hover" + (dark ? " dark" : ""));
                renderHover(el, result.parts);
                if (!el.firstChild) return;
                hideHover();
                document.body.appendChild(el);
                var p = result.pos;
                var range = p ? new Range(p.sl, p.sc, p.el, p.ec) : new Range(word.row, word.start, word.row, word.end);
                var at = ace.renderer.textToScreenCoordinates(range.start.row, range.start.column);
                place(el, at.pageX, at.pageY, ace.renderer.lineHeight);
                el.addEventListener("mouseleave", function() { hideHover(); });
                hover = { el: el, ace: ace, range: range };
            });
        }

        function hideHover(keepTimer) {
            if (!keepTimer) {
                clearTimeout(hoverTimer);
                hoverSeq++;
            }
            if (hover && hover.el.parentNode) hover.el.parentNode.removeChild(hover.el);
            hover = null;
        }

        // The parts of a hover as elements: code as it is; text with its
        // fenced code as code, the rest as paragraphs. Everything is
        // inserted as text.
        function renderHover(el, parts) {
            var left = HOVER_MAX;
            (parts || []).forEach(function(part) {
                if (left <= 0) return;
                if (part.code != null) return code(part.code);
                if (part.plain) return paragraph(part.text);
                String(part.text).split(/^```[^\n]*$/m).forEach(function(chunk, i) {
                    if (i % 2) code(chunk.replace(/^\n|\n$/g, ""));
                    else chunk.split(/\n{2,}/).forEach(function(p) { paragraph(inline(p)); });
                });
            });
            function code(text) {
                if (!text.trim() || left <= 0) return;
                el.appendChild(element("pre", "lsp-hover-code", text.slice(0, left)));
                left -= text.length;
            }
            function paragraph(text) {
                text = text.trim();
                if (!text || left <= 0) return;
                el.appendChild(element("div", "lsp-hover-text", text.slice(0, left)));
                left -= text.length;
            }
            // markdown's marks, without what they mark up
            function inline(text) {
                return text.replace(/^#{1,6}\s+/gm, "").replace(/\*\*([^*]+)\*\*/g, "$1").replace(/`([^`]+)`/g, "$1")
                    .replace(/\[([^\]]+)\]\((?:[^)]+)\)/g, "$1").replace(/\\([\\`*_{}\[\]()#+\-.!<>])/g, "$1")
                    .replace(/&nbsp;/g, " ").replace(/^\s*---+\s*$/gm, "");
            }
        }

        /***** A list at the cursor, and a box to type a name in *****/

        function closePopup() {
            if (!popup) return;
            var p = popup;
            popup = null;
            document.removeEventListener("mousedown", p.onOutside, true);
            if (p.el.parentNode) p.el.parentNode.removeChild(p.el);
        }

        function openPopup(tab, el, onKey) {
            closePopup();
            hideHover();
            var ace = tab.editor.ace;
            document.body.appendChild(el);
            var cursor = ace.getCursorPosition();
            var at = ace.renderer.textToScreenCoordinates(cursor.row, cursor.column);
            place(el, at.pageX, at.pageY, ace.renderer.lineHeight);
            var p = popup = {
                el: el,
                tab: tab,
                onOutside: function(e) {
                    if (!el.contains(e.target)) closePopup();
                }
            };
            document.addEventListener("mousedown", p.onOutside, true);
            el.addEventListener("keydown", function(e) {
                if (e.keyCode == 27) {
                    e.preventDefault();
                    e.stopPropagation();
                    closePopup();
                    ace.focus();
                }
                else onKey && onKey(e);
            });
            return p;
        }

        // items: [{ label, detail, title }]; onPick(item, index)
        function showList(tab, title, items, onPick) {
            var el = element("div", "lsp-list" + (dark ? " dark" : ""));
            el.tabIndex = 0;
            el.appendChild(element("div", "lsp-list-title", title));
            var rows = element("div", "lsp-list-rows");
            el.appendChild(rows);
            var selected = 0;
            var nodes = items.map(function(item, i) {
                var row = element("div", "lsp-list-row");
                row.appendChild(element("span", "lsp-list-label", item.label));
                if (item.detail) row.appendChild(element("span", "lsp-list-detail", item.detail));
                if (item.title) row.title = item.title;
                row.addEventListener("mousedown", function(e) {
                    e.preventDefault();
                    pick(i);
                });
                rows.appendChild(row);
                return row;
            });
            function select(i) {
                if (!nodes.length) return;
                nodes[selected].classList.remove("lsp-list-selected");
                selected = (i + nodes.length) % nodes.length;
                nodes[selected].classList.add("lsp-list-selected");
                if (nodes[selected].scrollIntoView) nodes[selected].scrollIntoView({ block: "nearest" });
            }
            function pick(i) {
                closePopup();
                tab.editor.ace.focus();
                onPick(items[i], i);
            }
            openPopup(tab, el, function(e) {
                if (e.keyCode == 40 || e.keyCode == 38) {
                    e.preventDefault();
                    select(selected + (e.keyCode == 40 ? 1 : -1));
                }
                else if (e.keyCode == 13 && nodes.length) {
                    e.preventDefault();
                    pick(selected);
                }
            });
            select(0);
            el.focus();
        }

        /***** Places: references, type definition, implementation *****/

        function lineOf(text, row) {
            var line = String(text).split("\n")[row] || "";
            return line.trim().slice(0, PREVIEW_LENGTH);
        }

        // Adds the text of its line to each place: from the editor for a
        // file that is open, else from the file (of the first files only)
        function withLines(locations, callback) {
            var texts = {};
            var paths = [];
            locations.forEach(function(l) {
                if (paths.indexOf(l.path) == -1) paths.push(l.path);
            });
            var waiting = 1;
            paths.forEach(function(path, i) {
                var tab = tabManager.findTab(path);
                if (tab && tab.document && typeof tab.document.value == "string") {
                    texts[path] = tab.document.value;
                }
                else if (i < PREVIEW_FILES) {
                    waiting++;
                    fs.readFile(path, function(err, data) {
                        if (!err) texts[path] = data;
                        done();
                    });
                }
            });
            done();
            function done() {
                if (--waiting) return;
                callback(locations.map(function(l) {
                    return { path: l.path, pos: l.pos, text: texts[l.path] != null ? lineOf(texts[l.path], l.pos.sl) : "" };
                }));
            }
        }

        function goTo(location) {
            tabManager.open({ path: location.path, focus: true, active: true }, function(err, tab) {
                var ace = !err && aceTab(tab) && tab.editor.ace;
                if (!ace) return;
                var p = location.pos;
                ace.selection.setSelectionRange(new Range(p.sl, p.sc, p.el, p.ec));
                ace.centerSelection();
            });
        }

        function showPlaces(type, title, none) {
            var tab = aceTab();
            if (!tab) return;
            request(type, tab, {}, function(err, result) {
                if (err) return flash(tab, err.message);
                var locations = result && result.locations || [];
                if (!locations.length)
                    return flash(tab, result && result.outside ? none + " in the workspace" : none);
                // one place that is not where the cursor is: go there
                if (locations.length == 1 && type != "references") return goTo(locations[0]);
                withLines(locations, function(places) {
                    var files = {};
                    places.forEach(function(p) { files[p.path] = true; });
                    var count = places.length + (result.more ? "+" : "") + " " + title
                        + (Object.keys(files).length > 1 ? " in " + Object.keys(files).length + " files" : "");
                    showList(tab, count, places.map(function(p) {
                        return { label: p.path.replace(/^\//, "") + ":" + (p.pos.sl + 1), detail: p.text, title: p.path };
                    }), function(item, i) {
                        goTo(places[i]);
                    });
                });
            });
        }

        /***** Edits *****/

        // The edits of one file, applied to a text
        function editText(text, edits) {
            var lines = text.split("\n");
            var starts = [0];
            for (var i = 0; i < lines.length; i++) starts.push(starts[i] + lines[i].length + 1);
            function offset(row, column) {
                if (row >= lines.length) return text.length;
                return starts[row] + Math.min(column, lines[row].length);
            }
            sorted(edits).forEach(function(e) {
                text = text.slice(0, offset(e.sl, e.sc)) + e.text + text.slice(offset(e.el, e.ec));
            });
            return text;
        }

        // from the end of the file to its start: an edit does not move the
        // places of those still to come
        function sorted(edits) {
            return edits.slice().sort(function(a, b) {
                return b.sl - a.sl || b.sc - a.sc;
            });
        }

        // Applies { files: [{ path, edits }] }: in the editor for a file
        // that is open, on disk otherwise. callback(err, { files, edits })
        function applyEdit(edit, callback) {
            var files = edit && edit.files || [];
            var total = 0, failed = [], written = [];
            var waiting = 1;
            files.forEach(function(file) {
                total += file.edits.length;
                var tab = tabManager.findTab(file.path);
                // the document of a tab that is not shown has no editor of its own
                var session = tab && tab.document && tab.document.getSession && tab.document.getSession();
                var aceSession = session && session.session;
                if (aceSession && aceSession.doc) {
                    var doc = aceSession.doc;
                    // one step to undo, per file
                    if (aceSession.markUndoGroup) aceSession.markUndoGroup();
                    sorted(file.edits).forEach(function(e) {
                        doc.replace(new Range(e.sl, e.sc, e.el, e.ec), e.text.replace(/\r\n?/g, "\n"));
                    });
                    if (aceSession.markUndoGroup) aceSession.markUndoGroup();
                    return;
                }
                waiting++;
                fs.readFile(file.path, function(err, data) {
                    if (err) {
                        failed.push(file.path);
                        return done();
                    }
                    fs.writeFile(file.path, editText(String(data), file.edits), function(err) {
                        if (err) failed.push(file.path);
                        else written.push(file.path);
                        done();
                    });
                });
            });
            done();
            function done() {
                if (--waiting) return;
                // the servers hear of the files that changed on disk
                if (written.length && boundHandler)
                    boundHandler.emit("lsp_files_changed", { paths: written });
                callback(failed.length ? new Error("Could not change " + failed.join(", ")) : null,
                    { files: files.length, edits: total });
            }
        }

        function summary(result, edit) {
            return result.edits + (result.edits == 1 ? " change" : " changes")
                + (result.files > 1 ? " in " + result.files + " files" : "")
                + (edit.skipped ? "; " + edit.skipped + " outside the workspace left out" : "");
        }

        /***** Rename *****/

        function rename() {
            var tab = aceTab();
            if (!tab) return;
            var ace = tab.editor.ace;
            request("prepareRename", tab, {}, function(err, prepared) {
                if (err) return flash(tab, err.message);
                var p = prepared && prepared.pos;
                var range = p ? new Range(p.sl, p.sc, p.el, p.ec)
                    : ace.session.getWordRange(ace.getCursorPosition().row, ace.getCursorPosition().column);
                var name = prepared && prepared.placeholder || ace.session.getTextRange(range);
                if (!name || /\s/.test(name)) return flash(tab, "This can't be renamed");

                var el = element("div", "lsp-list lsp-rename" + (dark ? " dark" : ""));
                el.appendChild(element("div", "lsp-list-title", "Rename " + name + " to"));
                var input = element("input", "lsp-rename-input");
                input.type = "text";
                input.value = name;
                input.spellcheck = false;
                input.setAttribute("aria-label", "New name");
                el.appendChild(input);
                el.appendChild(element("div", "lsp-list-hint", "Enter renames it in every file that uses it; Esc cancels"));
                openPopup(tab, el, function(e) {
                    if (e.keyCode != 13) return;
                    e.preventDefault();
                    var newName = input.value.trim();
                    closePopup();
                    ace.focus();
                    if (!newName || newName == name) return;
                    request("rename", tab, { pos: range.start, newName: newName }, function(err, edit) {
                        if (err) return flash(tab, err.message);
                        if (!edit.files.length) return flash(tab, "Nothing to rename");
                        applyEdit(edit, function(err, result) {
                            if (err) return showError(err.message);
                            flash(tab, "Renamed: " + summary(result, edit));
                        });
                    });
                });
                input.focus();
                input.select();
            });
        }

        /***** Quick fixes and refactorings *****/

        function codeActions() {
            var tab = aceTab();
            if (!tab) return;
            var ace = tab.editor.ace;
            var r = ace.getSelectionRange();
            request("codeActions", tab, { range: { sl: r.start.row, sc: r.start.column, el: r.end.row, ec: r.end.column }}, function(err, result) {
                if (err) return flash(tab, err.message);
                var actions = result && result.actions || [];
                if (!actions.length) return flash(tab, "No fixes or refactorings here");
                // the fixes first, the server's preferred one before the others
                var order = actions.slice().sort(function(a, b) {
                    return rank(a) - rank(b);
                });
                showList(tab, "Quick fixes and refactorings", order.map(function(a) {
                    return { label: a.title, detail: a.kind.split(".")[0] };
                }), function(item, i) {
                    request("applyCodeAction", tab, { index: order[i].index }, function(err, edit) {
                        if (err) return flash(tab, err.message);
                        applyEdit(edit, function(err, applied) {
                            if (err) return showError(err.message);
                            if (applied.edits) flash(tab, summary(applied, edit));
                        });
                    });
                });
            });
            function rank(a) {
                return (a.preferred ? 0 : 2) + (/^quickfix/.test(a.kind) ? 0 : 1);
            }
        }

        /***** Format *****/

        function format() {
            var tab = aceTab();
            if (!tab) return;
            var session = tab.editor.ace.session;
            request("format", tab, { tabSize: session.getTabSize(), insertSpaces: session.getUseSoftTabs() }, function(err, edit) {
                if (err) return flash(tab, err.message);
                if (!edit.files.length) return flash(tab, "Already formatted");
                applyEdit(edit, function(err) {
                    if (err) showError(err.message);
                });
            });
        }

        /***** Lifecycle *****/

        plugin.on("load", function() {
            if (loaded) return;
            loaded = true;

            ui.insertCss(require("text!./lsp.css"), plugin);

            settings.on("read", function() {
                settings.setDefaults("user/lsp", [["hover", "true"]]);
            }, plugin);

            lsp.on("handler", bind, plugin);
            bind();

            aceHandle.on("create", function(e) {
                attach(e.editor);
            }, plugin);
            aceHandle.on("themeChange", function(e) {
                dark = !e.theme || !!e.theme.isDark;
            }, plugin);
            // another tab (the event also comes when the tab that has the
            // focus gets it again)
            tabManager.on("focus", function() {
                var tab = tabManager.focussedTab;
                if (tab !== hoverTab) hideHover();
                if (popup && popup.tab !== tab) closePopup();
            }, plugin);

            var available = function() {
                var tab = aceTab();
                return !!(tab && lsp.handles(tab.path));
            };
            var list = [
                ["lspreferences", "Find References", { mac: "Shift-F12", win: "Shift-F12" }, 760,
                    function() { showPlaces("references", "references", "No references found"); }],
                ["lsptypedefinition", "Go to Type Definition", null, 762,
                    function() { showPlaces("typeDefinition", "type definitions", "No type definition found"); }],
                ["lspimplementation", "Go to Implementation", null, 764,
                    function() { showPlaces("implementation", "implementations", "No implementation found"); }],
                ["lsprename", "Rename Symbol…", { mac: "F2", win: "F2" }, 766, rename],
                ["lspcodeaction", "Quick Fix…", { mac: "Option-Enter", win: "Alt-Enter" }, 768, codeActions],
                ["lspformat", "Format Document", { mac: "Shift-Option-F", win: "Shift-Alt-F" }, 770, format]
            ];
            list.forEach(function(item) {
                commands.addCommand({
                    name: item[0],
                    hint: item[1].replace("…", "").toLowerCase() + ", with the file's language server",
                    bindKey: item[2] || undefined,
                    isAvailable: available,
                    exec: item[4]
                }, plugin);
            });
            aceHandle.getElement("menu", function(menu) {
                menus.addItemToMenu(menu, new ui.divider(), 755, plugin);
                list.forEach(function(item) {
                    menus.addItemToMenu(menu, new ui.item({ caption: item[1], command: item[0] }), item[3], plugin);
                });
            });
            menus.addItemByPath("Goto/Find References", new ui.item({ command: "lspreferences" }), 1460, plugin);
            menus.addItemByPath("Goto/Go to Type Definition", new ui.item({ command: "lsptypedefinition" }), 1462, plugin);
            menus.addItemByPath("Goto/Go to Implementation", new ui.item({ command: "lspimplementation" }), 1464, plugin);
            menus.addItemByPath("Edit/Code Formatting/Format Document with the Language Server", new ui.item({ command: "lspformat" }), 150, plugin);
        });

        plugin.on("unload", function() {
            hideHover();
            closePopup();
            boundHandler = null;
            pending = {};
            loaded = false;
        });

        /***** Register and define API *****/

        plugin.freezePublicAPI({
            /**
             * Asks the language server of a tab's file: "hover",
             * "references", "prepareRename", "rename" ({ newName }),
             * "codeActions" ({ range }), "applyCodeAction" ({ index }),
             * "format".
             * @param {String}   type
             * @param {Tab}      tab
             * @param {Object}   extra     what the request takes besides the cursor
             * @param {Function} callback  (err, result)
             */
            request: request,
            /**
             * Applies { files: [{ path, edits: [{ sl, sc, el, ec, text }] }] }
             * @param {Object}   edit
             * @param {Function} callback  (err, { files, edits })
             */
            applyEdit: applyEdit,
            /** The edits of one file applied to its text (for tests) */
            editText: editText
        });

        register(null, { "language.lsp.features": plugin });
    }
});

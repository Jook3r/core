/**
 * A Language Server Protocol client for the language worker.
 *
 * Runs language servers (e.g. TypeScript 7: tsc --lsp --stdio) in the
 * workspace through workerUtil.spawn, keeps the open files in sync, and
 * answers the language worker's calls: completion, markers (diagnostics),
 * jump to definition, parameter hints (signature help), outline and the
 * other places of the name under the cursor. What the IDE asks for itself
 * (../features.js: hover, references, rename, code actions, formatting)
 * comes as an "lsp_request" and is answered with an "lsp_response". The
 * servers are configured by ../lsp.js.
 */
define(function(require, exports, module) {

var baseHandler = require("plugins/c9.ide.language/base_handler");
var workerUtil = require("plugins/c9.ide.language/worker_util");

var REQUEST_TIMEOUT = 15000;
var TOOLTIP_TIMEOUT = 1500;     // parameter hints are asked on every cursor move
var MAX_COMPLETIONS = 500;
var MAX_RESTARTS = 3;
var MAX_LOCATIONS = 500;        // references listed
var MAX_ACTIONS = 30;
// A server may be installed for the user only: these are not on the PATH
// of a service
var SPAWN = 'PATH="$PATH:$HOME/.local/bin:$HOME/go/bin:$HOME/.cargo/bin:$HOME/.npm-global/bin:/usr/local/go/bin"; exec "$0" "$@"';

var handler = module.exports = Object.create(baseHandler);

var config = { servers: [], workspaceDir: "/", home: "/" };
var clients = Object.create(null);      // server name -> Client
var encoder = new TextEncoder();
var decoder = new TextDecoder();

handler.init = function(callback) {
    handler.getEmitter().on("lsp_config", function(e) {
        config = e;
        // stop the servers that were removed or changed
        Object.keys(clients).forEach(function(name) {
            var server = serverByName(name);
            if (!server || JSON.stringify(server) != JSON.stringify(clients[name].server)) {
                clients[name].stop();
                delete clients[name];
            }
        });
    });
    // files the IDE changed on disk (a rename in files that are not open)
    handler.getEmitter().on("lsp_files_changed", function(e) {
        var changes = (e.paths || []).map(function(path) {
            return { uri: toUri(toFsPath(path)), type: 2 };
        });
        Object.keys(clients).forEach(function(name) {
            var client = clients[name];
            var mine = changes.filter(function(c) { return matches(client.server.extensions, c.uri); });
            if (client.ready && mine.length)
                client.notify("workspace/didChangeWatchedFiles", { changes: mine });
        });
    });
    handler.getEmitter().on("lsp_request", function(e) {
        onRequest(e, function(err, result) {
            handler.getEmitter().emit("lsp_response", {
                id: e.id, err: err ? String(err.message || err) : null, result: err ? null : result
            });
        });
    });
    callback();
};

handler.handlesLanguage = function(language) {
    return config.servers.some(function(server) {
        return server.languages.indexOf(language) != -1;
    });
};

handler.getIdentifierRegex = function() {
    return /[\w$]/;
};

handler.getCompletionRegex = function() {
    return /\.$/;
};

handler.onDocumentOpen = function(path, doc, oldPath, callback) {
    var client = clientFor(path);
    if (client) client.sync(path, doc);
    callback();
};

handler.onUpdate = function(doc, callback) {
    var client = clientFor(handler.path);
    if (client) client.sync(handler.path, doc);
    callback();
};

handler.onDocumentClose = function(path, callback) {
    var client = clientFor(path);
    if (client) client.close(path);
    callback();
};

handler.complete = function(doc, ast, pos, options, callback) {
    var path = options.path || handler.path;
    var client = clientFor(path);
    if (!client) return callback();
    var uri = client.sync(path, doc);
    client.request("textDocument/completion", {
        textDocument: { uri: uri },
        position: { line: pos.row, character: pos.column }
    }, REQUEST_TIMEOUT, function(err, result) {
        if (err || !result) return callback();
        var prefix = (options.identifierPrefix || "").toLowerCase();
        var items = (Array.isArray(result) ? result : result.items || []).filter(function(item) {
            return (item.filterText || item.label).toLowerCase().indexOf(prefix) === 0;
        });
        items.sort(function(a, b) {
            var sa = a.sortText || a.label, sb = b.sortText || b.label;
            return sa < sb ? -1 : sa > sb ? 1 : 0;
        });
        callback(null, items.slice(0, MAX_COMPLETIONS).map(function(item, i) {
            var edit = item.textEdit && (item.textEdit.newText != null) ? item.textEdit.newText : null;
            var module = item.labelDetails && item.labelDetails.description;
            return {
                name: item.label,
                replaceText: edit != null ? edit : item.insertText || item.label,
                icon: completionIcon(item.kind),
                meta: module || item.detail || "",
                priority: 5,
                score: MAX_COMPLETIONS - i,
                isContextual: true,
                noDoc: true
            };
        }));
    });
};

handler.tooltip = function(doc, ast, pos, options, callback) {
    var path = options.path || handler.path;
    var client = clientFor(path);
    if (!client || !client.ready || !client.capabilities.signatureHelpProvider) return callback();
    var uri = client.sync(path, doc);
    client.request("textDocument/signatureHelp", {
        textDocument: { uri: uri },
        position: { line: pos.row, character: pos.column }
    }, TOOLTIP_TIMEOUT, function(err, help) {
        if (err || !help || !help.signatures || !help.signatures.length)
            return callback();
        // the worker takes tooltip results as the first argument
        callback({
            hint: signatureHtml(help),
            pos: { sl: pos.row, sc: pos.column, el: pos.row, ec: pos.column }
        });
    });
};

handler.jumpToDefinition = function(doc, ast, pos, options, callback) {
    var path = options.path || handler.path;
    var client = clientFor(path);
    if (!client) return callback();
    var uri = client.sync(path, doc);
    client.request("textDocument/definition", {
        textDocument: { uri: uri },
        position: { line: pos.row, character: pos.column }
    }, REQUEST_TIMEOUT, function(err, result) {
        if (err || !result) return callback();
        callback(null, [].concat(result).map(function(location) {
            var range = location.targetSelectionRange || location.range;
            var target = fromUri(location.targetUri || location.uri);
            if (!target || !range) return null;
            return { path: target, row: range.start.line, column: range.start.character, icon: "unknown" };
        }).filter(Boolean));
    });
};

handler.highlightOccurrences = function(doc, ast, pos, options, callback) {
    var path = options.path || handler.path;
    var client = clientFor(path);
    if (!client || !client.ready || !client.capabilities.documentHighlightProvider) return callback();
    var uri = client.sync(path, doc);
    client.request("textDocument/documentHighlight", {
        textDocument: { uri: uri },
        position: { line: pos.row, character: pos.column }
    }, TOOLTIP_TIMEOUT, function(err, result) {
        if (err || !result || !result.length) return callback();
        callback(null, { markers: result.slice(0, MAX_LOCATIONS).map(function(h) {
            var here = h.range.start.line == pos.row && h.range.start.character <= pos.column
                && h.range.end.character >= pos.column;
            return { pos: toPos(h.range), type: here ? "occurrence_main" : "occurrence_other" };
        })});
    });
};

handler.analyze = function(doc, ast, options, callback) {
    var path = options.path || handler.path;
    var client = clientFor(path);
    if (!client || options.minimalAnalysis) return callback();
    var uri = client.sync(path, doc);
    client.whenReady(function(err) {
        if (err) return callback();
        if (!client.capabilities.diagnosticProvider) {
            // a server that only pushes them: what it sent last
            return callback(null, toMarkers(client.diagnostics[uri] || []));
        }
        client.request("textDocument/diagnostic", { textDocument: { uri: uri } }, REQUEST_TIMEOUT, function(err, report) {
            if (err || !report) return callback();
            // (kept for the code actions, which are asked for with them)
            if (report.items) client.diagnostics[uri] = report.items;
            callback(null, toMarkers(report.items || client.diagnostics[uri] || []));
        });
    });
};

handler.outline = function(doc, ast, options, callback) {
    var path = handler.path;
    var client = clientFor(path);
    if (!client || !matches(client.server.outline, path)) return callback();
    var uri = client.sync(path, doc);
    client.request("textDocument/documentSymbol", { textDocument: { uri: uri } }, REQUEST_TIMEOUT, function(err, symbols) {
        if (err || !symbols) return callback();
        callback(null, { items: symbols.map(outlineItem) });
    });
};

/***** What the IDE asks for (../features.js) *****/

// e: { id, type, path, value (the document's text), pos: { row, column }, ... }
function onRequest(e, callback) {
    var client = clientFor(e.path);
    if (!client) return callback(new Error("No language server for this file"));
    var uri = client.sync(e.path, String(e.value == null ? "" : e.value));
    var at = { textDocument: { uri: uri }, position: e.pos && { line: e.pos.row, character: e.pos.column } };
    var caps = function(name) { return client.capabilities[name]; };
    client.whenReady(function(err) {
        if (err) return callback(err);
        switch (e.type) {
            case "capabilities":
                return callback(null, {
                    server: client.server.name,
                    hover: !!caps("hoverProvider"),
                    references: !!caps("referencesProvider"),
                    typeDefinition: !!caps("typeDefinitionProvider"),
                    implementation: !!caps("implementationProvider"),
                    rename: !!caps("renameProvider"),
                    codeAction: !!caps("codeActionProvider"),
                    format: !!caps("documentFormattingProvider")
                });
            case "hover":
                if (!caps("hoverProvider")) return callback(null, null);
                // (the first one of a project can take seconds; the IDE drops an
                // answer that comes when the mouse is elsewhere)
                return client.request("textDocument/hover", at, REQUEST_TIMEOUT, function(err, hover) {
                    if (err || !hover || !hover.contents) return callback(null, null);
                    var parts = hoverParts(hover.contents);
                    callback(null, parts.length ? { parts: parts, pos: hover.range ? toPos(hover.range) : null } : null);
                });
            case "references":
            case "typeDefinition":
            case "implementation":
                var method = "textDocument/" + e.type;
                if (!caps(e.type + "Provider")) return callback(new Error("The language server can't do this"));
                var params = { textDocument: at.textDocument, position: at.position };
                if (e.type == "references") params.context = { includeDeclaration: true };
                return client.request(method, params, REQUEST_TIMEOUT, function(err, result) {
                    if (err) return callback(err);
                    var outside = 0;
                    var locations = [].concat(result || []).map(function(location) {
                        var range = location.targetSelectionRange || location.range;
                        var target = fromUri(location.targetUri || location.uri);
                        if (!target) outside++;
                        return target && range ? { path: target, pos: toPos(range) } : null;
                    }).filter(Boolean);
                    callback(null, { locations: locations.slice(0, MAX_LOCATIONS), more: Math.max(0, locations.length - MAX_LOCATIONS), outside: outside });
                });
            case "prepareRename":
                if (!caps("renameProvider")) return callback(new Error("The language server can't rename"));
                if (!caps("renameProvider").prepareProvider) return callback(null, {});
                return client.request("textDocument/prepareRename", at, REQUEST_TIMEOUT, function(err, result) {
                    if (err) return callback(err);
                    if (!result) return callback(new Error("This can't be renamed"));
                    var range = result.range || (result.start ? result : null);
                    callback(null, { pos: range ? toPos(range) : null, placeholder: result.placeholder || null });
                });
            case "rename":
                if (!caps("renameProvider")) return callback(new Error("The language server can't rename"));
                return client.request("textDocument/rename", {
                    textDocument: at.textDocument, position: at.position, newName: String(e.newName)
                }, REQUEST_TIMEOUT, function(err, edit) {
                    if (err) return callback(err);
                    callback(null, workspaceEdit(edit));
                });
            case "codeActions":
                if (!caps("codeActionProvider")) return callback(null, { actions: [] });
                var range = toRange(e.range || { sl: e.pos.row, sc: e.pos.column, el: e.pos.row, ec: e.pos.column });
                return client.request("textDocument/codeAction", {
                    textDocument: at.textDocument,
                    range: range,
                    context: {
                        diagnostics: (client.diagnostics[uri] || []).filter(function(d) { return overlaps(d.range, range); }),
                        triggerKind: 1
                    }
                }, REQUEST_TIMEOUT, function(err, actions) {
                    if (err) return callback(err);
                    // kept until the next list: the one that is picked is applied by its number
                    client.actions = (actions || []).filter(function(a) {
                        return a && a.title && !a.disabled;
                    }).slice(0, MAX_ACTIONS);
                    callback(null, { actions: client.actions.map(function(a, i) {
                        return { index: i, title: a.title, kind: a.kind || "", preferred: !!a.isPreferred };
                    })});
                });
            case "applyCodeAction":
                return applyCodeAction(client, (client.actions || [])[e.index], callback);
            case "format":
                if (!caps("documentFormattingProvider")) return callback(new Error("The language server can't format"));
                return client.request("textDocument/formatting", {
                    textDocument: at.textDocument,
                    options: { tabSize: e.tabSize || 4, insertSpaces: e.insertSpaces !== false,
                        trimTrailingWhitespace: true, insertFinalNewline: true }
                }, REQUEST_TIMEOUT, function(err, edits) {
                    if (err) return callback(err);
                    callback(null, { files: edits && edits.length ? [{ path: e.path, edits: edits.map(toEdit) }] : [], skipped: 0 });
                });
            default:
                callback(new Error("Unknown request: " + e.type));
        }
    });
}

// An action is an edit, a command for the server to run (which then asks
// for an edit: workspace/applyEdit, see onMessage), or both; some servers
// give the edit only when asked again (codeAction/resolve)
function applyCodeAction(client, action, callback) {
    if (!action) return callback(new Error("That action is gone: ask again"));
    var provider = client.capabilities.codeActionProvider;
    // (a Command in the place of an action has its name in .command)
    var isCommand = typeof action.command == "string";
    if (!isCommand && !action.edit && !action.command && provider && provider.resolveProvider) {
        return client.request("codeAction/resolve", action, REQUEST_TIMEOUT, function(err, resolved) {
            if (err || !resolved) return callback(err || new Error("The action has nothing to do"));
            run(resolved);
        });
    }
    run(action);

    function run(action) {
        var edit = !isCommand && action.edit ? workspaceEdit(action.edit) : { files: [], skipped: 0 };
        var command = isCommand ? action : action.command;
        if (!command || !command.command) return callback(null, edit);
        client.request("workspace/executeCommand", {
            command: command.command, arguments: command.arguments
        }, REQUEST_TIMEOUT, function(err) {
            callback(err, edit);
        });
    }
}

// A WorkspaceEdit as { files: [{ path, edits: [{ sl, sc, el, ec, text }] }],
// skipped: the number of changes that are left out (files outside the
// workspace and the home folder; files to create, rename or delete) }
function workspaceEdit(edit) {
    var files = Object.create(null);
    var skipped = 0;
    function add(uri, edits) {
        var path = fromUri(uri);
        if (!path) return skipped++;
        files[path] = (files[path] || []).concat((edits || []).map(toEdit));
    }
    if (edit && edit.documentChanges) {
        edit.documentChanges.forEach(function(change) {
            if (change.kind || !change.textDocument) return skipped++;
            add(change.textDocument.uri, change.edits);
        });
    }
    else if (edit && edit.changes) {
        Object.keys(edit.changes).forEach(function(uri) { add(uri, edit.changes[uri]); });
    }
    return { files: Object.keys(files).map(function(path) { return { path: path, edits: files[path] }; }), skipped: skipped };
}

function toEdit(edit) {
    var pos = toPos(edit.range);
    pos.text = String(edit.newText == null ? "" : edit.newText);
    return pos;
}

function toPos(range) {
    return { sl: range.start.line, sc: range.start.character, el: range.end.line, ec: range.end.character };
}

function toRange(pos) {
    return { start: { line: pos.sl, character: pos.sc }, end: { line: pos.el, character: pos.ec } };
}

function overlaps(a, b) {
    function before(p, q) { return p.line < q.line || p.line == q.line && p.character < q.character; }
    return !before(a.end, b.start) && !before(b.end, a.start);
}

// Hover contents (a string, { language, value }, { kind, value }, or a list
// of them) as parts: { code, language } or { text } (markdown)
function hoverParts(contents) {
    var parts = [];
    [].concat(contents).forEach(function(c) {
        if (c == null) return;
        if (typeof c == "string") {
            if (c.trim()) parts.push({ text: c });
        }
        else if (c.language != null) {
            if (String(c.value || "").trim()) parts.push({ code: String(c.value), language: String(c.language) });
        }
        else if (String(c.value || "").trim()) {
            parts.push(c.kind == "plaintext" ? { text: String(c.value), plain: true } : { text: String(c.value) });
        }
    });
    return parts;
}

/***** Servers *****/

function serverByName(name) {
    return config.servers.filter(function(server) { return server.name == name; })[0];
}

// The client for a file: by its extension, so that e.g. JavaScript inside
// an HTML file isn't sent to the server as a JavaScript file
function clientFor(path) {
    if (!path) return null;
    var server = config.servers.filter(function(server) {
        return matches(server.extensions, path);
    })[0];
    if (!server) return null;
    return clients[server.name] || (clients[server.name] = new Client(server));
}

function matches(extensions, path) {
    var ext = /\.([^.\/]+)$/.exec(path);
    return !!(ext && extensions && extensions.indexOf(ext[1]) != -1);
}

function Client(server) {
    this.server = server;
    this.nextId = 1;
    this.pending = Object.create(null);     // request id -> callback
    this.waiting = [];                      // functions to call once initialized
    this.docs = Object.create(null);        // uri -> { version, text }
    this.diagnostics = Object.create(null); // uri -> pushed diagnostics
    this.capabilities = {};
    this.buffer = new Uint8Array(0);
    this.ready = false;
    this.generation = 0;
    this.exits = 0;
    this.failed = null;
    this.actions = [];                      // the code actions listed last
    // the commands to try: the first that is installed is the server
    this.commands = server.commands || [{ command: server.command, args: server.args }];
    this.commandIndex = 0;
    this.start();
}

function status(server, state, detail) {
    handler.getEmitter().emit("lsp_status", { server: server.name, state: state, detail: detail || "" });
}

// Each start is a generation: events of a process that was replaced or
// stopped are ignored
Client.prototype.start = function() {
    var self = this;
    var server = this.server;
    var generation = ++this.generation;
    var command = this.commands[this.commandIndex];
    this.stderr = "";
    this.initialized = false;
    status(server, "starting", command.command);
    workerUtil.spawn("sh", {
        args: ["-c", SPAWN, command.command].concat(command.args || []),
        cwd: config.workspaceDir,
        stdoutEncoding: "utf8",
        stderrEncoding: "utf8"
    }, function(err, child) {
        if (generation != self.generation) {
            if (!err) child.kill();
            return;
        }
        if (err) return self.onExit(err);
        self.child = child;
        child.stdout.on("data", function(data) {
            if (generation == self.generation) self.onData(data);
        });
        child.stderr.on("data", function(data) {
            if (generation == self.generation) self.stderr = (self.stderr + data).slice(-2000);
        });
        child.on("error", function(e) {
            if (generation == self.generation) self.onExit(e);
        });
        child.on("exit", function(code) {
            if (generation != self.generation) return;
            var err = new Error(server.name + " language server exited with " + code
                + (self.stderr ? ": " + self.stderr.trim() : ""));
            // the shell's "command not found": not installed
            if (code == 127 && !self.initialized) err.code = "ENOENT";
            self.onExit(err);
        });
        self.request("initialize", initializeParams(server), REQUEST_TIMEOUT, function(err, result) {
            if (generation != self.generation) return;
            if (err) {
                child.kill();
                return self.onExit(err);
            }
            self.capabilities = result && result.capabilities || {};
            self.ready = true;
            self.initialized = true;
            status(server, "running", command.command);
            self.notify("initialized", {});
            var waiting = self.waiting;
            self.waiting = [];
            waiting.forEach(function(fn) { fn(); });
            // the open files are checked again: what was asked while the
            // server started or restarted may have gone unanswered
            handler.getEmitter().emit("lsp_ready", { server: server.name });
        });
    });
};

Client.prototype.whenReady = function(fn) {
    if (this.failed) return fn(this.failed);
    if (this.ready) return fn();
    this.waiting.push(fn);
};

Client.prototype.request = function(method, params, timeout, callback) {
    var self = this;
    if (method != "initialize" && !this.ready) {
        return this.whenReady(function(err) {
            if (err) return callback(err);
            self.request(method, params, timeout, callback);
        });
    }
    var id = this.nextId++;
    var timer = setTimeout(function() {
        delete self.pending[id];
        self.notify("$/cancelRequest", { id: id });
        callback(new Error(method + " timed out"));
    }, timeout);
    this.pending[id] = function(err, result) {
        clearTimeout(timer);
        callback(err, result);
    };
    this.write({ jsonrpc: "2.0", id: id, method: method, params: params });
};

Client.prototype.notify = function(method, params) {
    var self = this;
    if (method != "initialized" && !this.ready)
        return this.whenReady(function(err) { if (!err) self.notify(method, params); });
    this.write({ jsonrpc: "2.0", method: method, params: params });
};

Client.prototype.write = function(message) {
    if (!this.child) return;
    var body = JSON.stringify(message);
    this.child.stdin.write("Content-Length: " + encoder.encode(body).length + "\r\n\r\n" + body);
};

// LSP messages: headers, an empty line, then Content-Length bytes of JSON
Client.prototype.onData = function(data) {
    var bytes = encoder.encode(data);
    var buffer = new Uint8Array(this.buffer.length + bytes.length);
    buffer.set(this.buffer);
    buffer.set(bytes, this.buffer.length);
    for (;;) {
        var end = headerEnd(buffer);
        if (end < 0) break;
        var length = /Content-Length:\s*(\d+)/i.exec(decoder.decode(buffer.subarray(0, end)));
        var start = end + 4;
        if (!length) {
            buffer = buffer.slice(start);
            continue;
        }
        length = parseInt(length[1], 10);
        if (buffer.length < start + length) break;
        var body = decoder.decode(buffer.subarray(start, start + length));
        buffer = buffer.slice(start + length);
        var message;
        try {
            message = JSON.parse(body);
        } catch (e) {
            continue;
        }
        this.onMessage(message);
    }
    this.buffer = buffer;
};

Client.prototype.onMessage = function(message) {
    if (message.id != null && !message.method) {
        var callback = this.pending[message.id];
        delete this.pending[message.id];
        if (callback)
            callback(message.error ? new Error(message.error.message) : null, message.result);
    }
    else if (message.id != null) {
        // a request from the server; no settings to give, nothing to register
        var result = null;
        if (message.method == "workspace/configuration") {
            // the settings ../lsp.js gives a server, by their section
            var given = this.server.settings || {};
            result = (message.params && message.params.items || []).map(function(item) {
                return item && item.section != null && given[item.section] !== undefined ? given[item.section] : null;
            });
        }
        else if (message.method == "workspace/applyEdit") {
            // what a command of a code action changes: the IDE applies it
            var edit = workspaceEdit(message.params && message.params.edit);
            handler.getEmitter().emit("lsp_apply_edit", edit);
            result = { applied: true };
        }
        this.write({ jsonrpc: "2.0", id: message.id, result: result });
    }
    else if (message.method == "textDocument/publishDiagnostics") {
        this.diagnostics[message.params.uri] = message.params.diagnostics || [];
    }
};

Client.prototype.onExit = function(err) {
    this.generation++;
    this.child = null;
    this.ready = false;
    this.docs = Object.create(null);    // a new process knows no documents
    this.buffer = new Uint8Array(0);
    var pending = this.pending;
    this.pending = Object.create(null);
    Object.keys(pending).forEach(function(id) { pending[id](err); });
    if (this.stopped) return;
    var missing = err && (err.code == "ENOENT" || /ENOENT/.test(err.message));
    if (missing && this.commandIndex + 1 < this.commands.length) {
        // not installed: the next one that could be the server
        this.commandIndex++;
        missing = false;
    }
    else if (missing || ++this.exits >= MAX_RESTARTS) {
        this.failed = err;
        status(this.server, missing ? "missing" : "failed", missing ? "" : err.message);
        // a server that is there for whoever installs it says nothing
        if (!(missing && this.server.optional)) {
            console.error("[lsp] " + err.message);
            workerUtil.showError(this.server.caption + " isn't available: " + (this.server.help || err.message));
        }
    }
    // what waited for this process fails; the next request syncs again
    var waiting = this.waiting;
    this.waiting = [];
    waiting.forEach(function(fn) { fn(err); });
    if (this.failed) return;
    console.warn("[lsp] " + err.message + "; restarting");
    this.start();
};

Client.prototype.stop = function() {
    this.stopped = true;
    this.generation++;
    if (this.child) this.child.kill();
};

// Opens the document on the server or sends its new text; returns its URI.
// doc: a Document, or its text (analyze() gets the text)
Client.prototype.sync = function(path, doc) {
    var uri = toUri(toFsPath(path));
    var text = typeof doc == "string" ? doc : doc.getValue();
    var open = this.docs[uri];
    if (!open) {
        this.docs[uri] = { version: 1, text: text };
        this.notify("textDocument/didOpen", { textDocument: {
            uri: uri, languageId: languageId(path, this.server), version: 1, text: text
        }});
    }
    else if (open.text !== text) {
        open.version++;
        open.text = text;
        this.notify("textDocument/didChange", {
            textDocument: { uri: uri, version: open.version },
            contentChanges: [{ text: text }]
        });
    }
    return uri;
};

Client.prototype.close = function(path) {
    var uri = toUri(toFsPath(path));
    if (!this.docs[uri]) return;
    delete this.docs[uri];
    delete this.diagnostics[uri];
    this.notify("textDocument/didClose", { textDocument: { uri: uri } });
};

function initializeParams(server) {
    var root = toUri(config.workspaceDir.replace(/(.)\/$/, "$1"));
    return {
        processId: null,
        clientInfo: { name: "Cloud9" },
        rootUri: root,
        workspaceFolders: [{ uri: root, name: config.workspaceDir.split("/").filter(Boolean).pop() || "/" }],
        initializationOptions: server.initializationOptions,
        capabilities: {
            general: { positionEncodings: ["utf-16"] },
            workspace: {
                configuration: true,
                workspaceFolders: true,
                applyEdit: true,
                workspaceEdit: { documentChanges: true },
                didChangeWatchedFiles: { dynamicRegistration: false }
            },
            textDocument: {
                synchronization: { dynamicRegistration: false },
                completion: { completionItem: { snippetSupport: false, labelDetailsSupport: true } },
                signatureHelp: { signatureInformation: {
                    documentationFormat: ["plaintext"],
                    parameterInformation: { labelOffsetSupport: true },
                    activeParameterSupport: true
                }},
                definition: { linkSupport: true },
                typeDefinition: { linkSupport: true },
                implementation: { linkSupport: true },
                references: {},
                documentHighlight: {},
                hover: { contentFormat: ["markdown", "plaintext"] },
                rename: { prepareSupport: true },
                codeAction: {
                    codeActionLiteralSupport: { codeActionKind: { valueSet: [
                        "", "quickfix", "refactor", "refactor.extract", "refactor.inline", "refactor.rewrite",
                        "source", "source.organizeImports", "source.fixAll"
                    ]}},
                    isPreferredSupport: true,
                    disabledSupport: true,
                    resolveSupport: { properties: ["edit"] }
                },
                formatting: {},
                documentSymbol: { hierarchicalDocumentSymbolSupport: true },
                publishDiagnostics: {},
                diagnostic: {}
            }
        }
    };
}

/***** Conversions *****/

function headerEnd(bytes) {
    for (var i = 0; i + 3 < bytes.length; i++) {
        if (bytes[i] == 13 && bytes[i + 1] == 10 && bytes[i + 2] == 13 && bytes[i + 3] == 10)
            return i;
    }
    return -1;
}

// Cloud9 paths: /file in the workspace, ~/file in the home folder
function toFsPath(path) {
    if (/^~(\/|$)/.test(path))
        return config.home.replace(/\/$/, "") + path.slice(1);
    return config.workspaceDir.replace(/\/$/, "") + (path.charAt(0) == "/" ? path : "/" + path);
}

function toUri(fsPath) {
    return "file://" + fsPath.split("/").map(encodeURIComponent).join("/");
}

function fromUri(uri) {
    if (!/^file:\/\//.test(uri || "")) return null;
    var fsPath = decodeURIComponent(uri.slice("file://".length));
    var workspace = config.workspaceDir.replace(/\/$/, "");
    var home = config.home.replace(/\/$/, "");
    if (fsPath.indexOf(workspace + "/") === 0)
        return fsPath.slice(workspace.length);
    if (fsPath.indexOf(home + "/") === 0)
        return "~" + fsPath.slice(home.length);
    return null; // outside the workspace and the home folder: can't be opened
}

function languageId(path, server) {
    var ext = (/\.([^.\/]+)$/.exec(path) || [])[1];
    if (server && server.languageIds && server.languageIds[ext])
        return server.languageIds[ext];
    return {
        ts: "typescript", mts: "typescript", cts: "typescript", tsx: "typescriptreact",
        js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascriptreact"
    }[ext] || ext;
}

function toMarkers(diagnostics) {
    return diagnostics.filter(function(d) {
        return d.severity != 4; // hints, e.g. "declared but never read"
    }).map(function(d) {
        return {
            pos: { sl: d.range.start.line, sc: d.range.start.character, el: d.range.end.line, ec: d.range.end.character },
            type: d.severity == 2 ? "warning" : d.severity == 3 ? "info" : "error",
            message: d.message + (d.code != null ? " (" + (d.source || "") + d.code + ")" : "")
        };
    });
}

// CompletionItemKind -> Cloud9's icons
function completionIcon(kind) {
    if (kind == 2 || kind == 3 || kind == 4) return "method";               // method, function, constructor
    if (kind == 7 || kind == 8 || kind == 9 || kind == 13) return "package"; // class, interface, module, enum
    if (kind == 14 || kind == 15) return "unknown2";                        // keyword, snippet
    if (kind == 23) return "event";
    return "property";
}

// SymbolKind -> Cloud9's icons
function symbolIcon(kind) {
    if (kind == 6 || kind == 9 || kind == 12) return "method";             // method, constructor, function
    if (kind == 2 || kind == 3 || kind == 5 || kind == 10 || kind == 11 || kind == 23)
        return "package";                                                   // module, namespace, class, enum, interface, struct
    return "property";
}

function outlineItem(symbol) {
    var range = symbol.range || symbol.location && symbol.location.range;
    var selection = symbol.selectionRange || range;
    return {
        icon: symbolIcon(symbol.kind),
        name: symbol.name,
        pos: { sl: range.start.line, sc: range.start.character, el: range.end.line, ec: range.end.character },
        displayPos: { sl: selection.start.line, sc: selection.start.character, el: selection.end.line, ec: selection.end.character },
        items: (symbol.children || []).map(outlineItem)
    };
}

function escapeHtml(text) {
    return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// "fn(a: number, b: string): void" with the active parameter highlighted,
// then that parameter's documentation
function signatureHtml(help) {
    var signature = help.signatures[help.activeSignature || 0] || help.signatures[0];
    var label = signature.label;
    var index = signature.activeParameter != null ? signature.activeParameter : help.activeParameter;
    var param = (signature.parameters || [])[index || 0];
    var start = -1, end = -1;
    if (param && Array.isArray(param.label)) {
        start = param.label[0];
        end = param.label[1];
    }
    else if (param && param.label) {
        start = label.indexOf(param.label, label.indexOf("("));
        end = start + param.label.length;
    }
    var html = start < 0
        ? escapeHtml(label)
        : escapeHtml(label.slice(0, start)) + '<span class="language_activeparam">'
            + escapeHtml(label.slice(start, end)) + "</span>" + escapeHtml(label.slice(end));
    var doc = param && param.documentation;
    doc = doc && (doc.value != null ? doc.value : doc);
    if (doc)
        html += '<div class="language_paramhelp"><span class="language_activeparamhelp">' + escapeHtml(doc) + "</span></div>";
    return html;
}

});

/**
 * A Language Server Protocol client for the language worker.
 *
 * Runs language servers (e.g. TypeScript 7: tsc --lsp --stdio) in the
 * workspace through workerUtil.spawn, keeps the open files in sync, and
 * answers the language worker's calls: completion, markers (diagnostics),
 * jump to definition, parameter hints (signature help) and outline. The
 * servers are configured by ../lsp.js.
 */
define(function(require, exports, module) {

var baseHandler = require("plugins/c9.ide.language/base_handler");
var workerUtil = require("plugins/c9.ide.language/worker_util");

var REQUEST_TIMEOUT = 15000;
var TOOLTIP_TIMEOUT = 1500;     // parameter hints are asked on every cursor move
var MAX_COMPLETIONS = 500;
var MAX_RESTARTS = 3;

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
            callback(null, toMarkers(report.items || []));
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
    this.start();
}

// Each start is a generation: events of a process that was replaced or
// stopped are ignored
Client.prototype.start = function() {
    var self = this;
    var server = this.server;
    var generation = ++this.generation;
    this.stderr = "";
    workerUtil.spawn(server.command, {
        args: server.args,
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
            if (generation == self.generation)
                self.onExit(new Error(server.name + " language server exited with " + code
                    + (self.stderr ? ": " + self.stderr.trim() : "")));
        });
        self.request("initialize", initializeParams(server), REQUEST_TIMEOUT, function(err, result) {
            if (generation != self.generation) return;
            if (err) {
                child.kill();
                return self.onExit(err);
            }
            self.capabilities = result && result.capabilities || {};
            self.ready = true;
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
        var result = message.method == "workspace/configuration"
            ? (message.params && message.params.items || []).map(function() { return null; })
            : null;
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
    if (++this.exits >= MAX_RESTARTS || /ENOENT|not found/.test(err && err.message)) {
        this.failed = err;
        console.error("[lsp] " + err.message);
        workerUtil.showError(this.server.caption + " isn't available: " + (this.server.help || err.message));
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
            uri: uri, languageId: languageId(path), version: 1, text: text
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
            workspace: { configuration: true, workspaceFolders: true },
            textDocument: {
                synchronization: { dynamicRegistration: false },
                completion: { completionItem: { snippetSupport: false, labelDetailsSupport: true } },
                signatureHelp: { signatureInformation: {
                    documentationFormat: ["plaintext"],
                    parameterInformation: { labelOffsetSupport: true },
                    activeParameterSupport: true
                }},
                definition: { linkSupport: true },
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

function languageId(path) {
    var ext = (/\.([^.\/]+)$/.exec(path) || [])[1];
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

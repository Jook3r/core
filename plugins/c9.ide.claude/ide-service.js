/**
 * Server half of the Claude Code IDE bridge (c9.ide.claude/ide.js).
 *
 * Claude Code, the `claude` CLI, connects to an editor when it finds one: it
 * then knows the file and the selection the user is looking at, shows the
 * changes it proposes as a diff in the editor, and reads the editor's
 * markers. It finds an editor by a lock file, ~/.claude/ide/<port>.lock, and
 * speaks MCP (JSON-RPC 2.0) with it over a WebSocket on that port of
 * 127.0.0.1, sending the lock file's token in a header. This is what the
 * extensions for VS Code and JetBrains do; here Cloud9 is the editor.
 *
 * Loaded into the vfs process with ext.loadRemotePlugin("claudeide", ...),
 * so there is one bridge per open IDE (browser tab). It
 *
 *  - listens on a free port of 127.0.0.1 and writes the lock file, with a
 *    random token that only this user can read (the folder is 0700, the
 *    file 0600); a connection without the token is refused,
 *  - answers the protocol's own requests (initialize, tools/list, ping),
 *  - relays a tool call (openDiff, getDiagnostics, openFile, ...) to the IDE
 *    in the browser over a vfs stream and the browser's answer back,
 *  - relays the browser's notifications (selection_changed, at_mentioned)
 *    to the connected CLIs.
 *
 * It never reads or writes a file of the workspace itself and runs nothing:
 * a CLI that connects can only ask the IDE to show something.
 *
 * Only built-in modules, as the code may be sent to a vfs process that has
 * no node_modules; hence the small WebSocket server below (RFC 6455: text
 * messages, fragments, ping, close).
 */
"use strict";

module.exports = function(vfs, options, register) {
    var http = require("http");
    var crypto = require("crypto");
    var fs = require("fs");
    var path = require("path");
    var os = require("os");
    var Stream = require("stream");

    /***** Constants *****/

    var WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
    var AUTH_HEADER = "x-claude-code-ide-authorization";
    var PROTOCOL_VERSION = "2024-11-05";
    var MAX_MESSAGE = 64 * 1024 * 1024;     // a message from a CLI (file contents in openDiff)
    var MAX_CLIENTS = 16;
    var CALL_TIMEOUT = 30000;               // a tool call the IDE does not answer
    var ABSENT_GRACE = 10000;               // the lock file stays this long without an IDE (a reload)
    // The page says that it is there (alive()) every 25 s; a page in a tab
    // that is not shown may do so once a minute only
    var ALIVE_TIMEOUT = 100000;
    // these wait for the user: no timeout
    var WAITING_TOOLS = { openDiff: true };

    var home = process.env.HOME || os.homedir();
    var workspaceDir = vfs.workspaceDir || options.workspaceDir || home;
    // where the CLI looks: its config folder (CLAUDE_CONFIG_DIR, as in a
    // terminal of this server), ~/.claude by default
    var lockDir = options.lockDir
        || path.join(process.env.CLAUDE_CONFIG_DIR || path.join(home, ".claude"), "ide");

    /***** The tools a CLI may call. All are carried out by the IDE in the
     * browser, except getWorkspaceFolders. *****/

    function tool(name, description, properties, required) {
        return {
            name: name,
            description: description,
            inputSchema: {
                type: "object",
                properties: properties || {},
                required: required || [],
                additionalProperties: false,
                $schema: "http://json-schema.org/draft-07/schema#"
            }
        };
    }
    var STRING = { type: "string" };
    var TOOLS = [
        tool("openDiff", "Open a diff of a file and its proposed contents in the editor, for the user to accept or reject", {
            old_file_path: STRING, new_file_path: STRING, new_file_contents: STRING, tab_name: STRING
        }, ["old_file_path", "new_file_path", "new_file_contents", "tab_name"]),
        tool("close_tab", "Close a tab by its name", { tab_name: STRING }, ["tab_name"]),
        tool("closeAllDiffTabs", "Close the diffs that openDiff opened"),
        tool("getDiagnostics", "The errors and warnings the editor shows, of one file or of all open files", { uri: STRING }),
        tool("openFile", "Open a file in the editor, optionally selecting text", {
            filePath: STRING, preview: { type: "boolean" }, startText: STRING, endText: STRING,
            selectToEndOfLine: { type: "boolean" }, makeFrontmost: { type: "boolean" }
        }, ["filePath"]),
        tool("getCurrentSelection", "The selected text of the active editor"),
        tool("getLatestSelection", "The most recent selection in an editor, also when it lost the focus"),
        tool("getOpenEditors", "The files open in tabs"),
        tool("getWorkspaceFolders", "The folders of the workspace"),
        tool("checkDocumentDirty", "Whether a file has unsaved changes in the editor", { filePath: STRING }, ["filePath"]),
        tool("saveDocument", "Save a file that is open in the editor", { filePath: STRING }, ["filePath"])
    ];
    var TOOL_NAMES = {};
    TOOLS.forEach(function(t) { TOOL_NAMES[t.name] = true; });

    /***** State *****/

    var token = crypto.randomBytes(32).toString("hex");
    var server, port, lockFile;
    var starting = null;        // callbacks waiting for the server
    var browser = null;         // the vfs stream to the IDE in the browser
    var clients = [];           // connected CLIs: { socket, send, pid, id }
    var calls = {};             // tool calls relayed to the browser, by id
    var callId = 0;
    var clientId = 0;
    var absentTimer = null;     // removes the lock file when the browser stays away
    var lastAlive = 0;          // when the IDE in the browser last said it is there
    var aliveTimer = null;
    var silent = false;         // the IDE has not said so for too long

    /***** WebSocket *****/

    function frame(opcode, payload) {
        var length = payload.length;
        var head;
        if (length < 126) {
            head = Buffer.alloc(2);
            head[1] = length;
        }
        else if (length < 65536) {
            head = Buffer.alloc(4);
            head[1] = 126;
            head.writeUInt16BE(length, 2);
        }
        else {
            head = Buffer.alloc(10);
            head[1] = 127;
            head.writeUInt32BE(Math.floor(length / 4294967296), 2);
            head.writeUInt32BE(length % 4294967296, 6);
        }
        head[0] = 0x80 | opcode;
        return Buffer.concat([head, payload]);
    }

    // Reads frames from a socket; onMessage(text) for each complete text
    // message. Returns nothing: the socket is destroyed on a protocol error.
    function readFrames(socket, onMessage) {
        var buffered = Buffer.alloc(0);
        var fragments = null;       // the parts of a message that is not complete
        var fragmentsLength = 0;

        function fail() {
            socket.destroy();
        }

        socket.on("data", function(chunk) {
            buffered = buffered.length ? Buffer.concat([buffered, chunk]) : chunk;
            while (true) {
                if (buffered.length < 2) return;
                var fin = (buffered[0] & 0x80) != 0;
                var opcode = buffered[0] & 0x0f;
                var masked = (buffered[1] & 0x80) != 0;
                var length = buffered[1] & 0x7f;
                var offset = 2;
                if (length == 126) {
                    if (buffered.length < 4) return;
                    length = buffered.readUInt16BE(2);
                    offset = 4;
                }
                else if (length == 127) {
                    if (buffered.length < 10) return;
                    length = buffered.readUInt32BE(2) * 4294967296 + buffered.readUInt32BE(6);
                    offset = 10;
                }
                // a client's frames are masked; no extensions were agreed
                if (!masked || (buffered[0] & 0x70) || length > MAX_MESSAGE)
                    return fail();
                if (buffered.length < offset + 4 + length) return;

                var mask = buffered.slice(offset, offset + 4);
                var payload = Buffer.from(buffered.slice(offset + 4, offset + 4 + length));
                for (var i = 0; i < payload.length; i++)
                    payload[i] ^= mask[i & 3];
                buffered = buffered.slice(offset + 4 + length);

                if (opcode == 0x8) {            // close
                    try { socket.end(frame(0x8, payload.slice(0, 2))); } catch (e) {}
                    return;
                }
                if (opcode == 0x9) {            // ping
                    try { socket.write(frame(0xA, payload)); } catch (e) {}
                    continue;
                }
                if (opcode == 0xA)              // pong
                    continue;
                if (opcode == 0x1 || opcode == 0x2) {
                    if (fragments) return fail();
                    fragments = [payload];
                    fragmentsLength = payload.length;
                }
                else if (opcode == 0x0) {
                    if (!fragments) return fail();
                    fragments.push(payload);
                    fragmentsLength += payload.length;
                    if (fragmentsLength > MAX_MESSAGE) return fail();
                }
                else {
                    return fail();
                }
                if (fin) {
                    var text = Buffer.concat(fragments).toString("utf8");
                    fragments = null;
                    try {
                        onMessage(text);
                    } catch (e) {
                        console.error("[claude ide] message failed", e);
                    }
                }
            }
        });
    }

    function sameToken(given) {
        var a = Buffer.from(String(given || ""));
        var b = Buffer.from(token);
        return a.length == b.length && crypto.timingSafeEqual(a, b);
    }

    function refuse(socket, status) {
        try {
            socket.end("HTTP/1.1 " + status + "\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
        } catch (e) {}
    }

    function onUpgrade(req, socket) {
        socket.on("error", function() {});
        var key = req.headers["sec-websocket-key"];
        if (String(req.headers.upgrade || "").toLowerCase() != "websocket" || !key)
            return refuse(socket, "400 Bad Request");
        // a page in a browser can open a WebSocket to 127.0.0.1 but can't
        // set this header (and would send an Origin)
        if (!sameToken(req.headers[AUTH_HEADER]) || req.headers.origin)
            return refuse(socket, "401 Unauthorized");
        if (clients.length >= MAX_CLIENTS)
            return refuse(socket, "503 Service Unavailable");

        var accept = crypto.createHash("sha1").update(key + WS_GUID).digest("base64");
        var head = "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
            + "Sec-WebSocket-Accept: " + accept + "\r\n";
        var offered = String(req.headers["sec-websocket-protocol"] || "").split(",")
            .map(function(p) { return p.trim(); });
        if (offered.indexOf("mcp") != -1)
            head += "Sec-WebSocket-Protocol: mcp\r\n";
        socket.write(head + "\r\n");
        socket.setNoDelay(true);

        var client = {
            id: ++clientId,
            socket: socket,
            pid: null,
            send: function(message) {
                if (socket.destroyed) return;
                try {
                    socket.write(frame(0x1, Buffer.from(JSON.stringify(message), "utf8")));
                } catch (e) {}
            }
        };
        clients.push(client);
        emit({ ev: "clients", count: clients.length });

        readFrames(socket, function(text) {
            var message;
            try {
                message = JSON.parse(text);
            } catch (e) {
                return client.send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" }});
            }
            (Array.isArray(message) ? message : [message]).forEach(function(m) {
                onRpc(client, m);
            });
        });
        // (the sockets of an http server stay open for writing when the
        // other side is done)
        socket.on("end", function() {
            socket.destroy();
        });
        socket.on("close", function() {
            var i = clients.indexOf(client);
            if (i == -1) return;
            clients.splice(i, 1);
            // what this CLI was waiting for is of no use now: a diff it
            // opened is closed
            Object.keys(calls).forEach(function(id) {
                if (calls[id].client === client) {
                    clearTimeout(calls[id].timer);
                    delete calls[id];
                    emit({ ev: "cancel", id: Number(id) });
                }
            });
            emit({ ev: "clients", count: clients.length });
            emit({ ev: "gone", client: client.id });
        });
    }

    /***** MCP *****/

    function textResult(text) {
        return { content: [{ type: "text", text: String(text) }] };
    }

    function onRpc(client, message) {
        if (!message || typeof message != "object" || typeof message.method != "string")
            return;     // an answer to something we did not ask, or not a message
        var id = message.id;
        var isRequest = id !== undefined && id !== null;
        var params = message.params || {};

        function result(value) {
            if (isRequest) client.send({ jsonrpc: "2.0", id: id, result: value });
        }
        function error(code, text) {
            if (isRequest) client.send({ jsonrpc: "2.0", id: id, error: { code: code, message: text }});
        }

        switch (message.method) {
            case "initialize":
                return result({
                    protocolVersion: typeof params.protocolVersion == "string"
                        ? params.protocolVersion : PROTOCOL_VERSION,
                    capabilities: { tools: { listChanged: false }},
                    serverInfo: { name: "Cloud9", version: String(options.version || "1") }
                });
            case "ping":
                return result({});
            case "tools/list":
                return result({ tools: TOOLS });
            case "prompts/list":
                return result({ prompts: [] });
            case "resources/list":
                return result({ resources: [] });
            case "resources/templates/list":
                return result({ resourceTemplates: [] });
            case "ide_connected":
                client.pid = typeof params.pid == "number" ? params.pid : null;
                emit({ ev: "connected", client: client.id, pid: client.pid });
                return result({});
            case "tools/call":
                return callTool(client, params, result, error);
            default:
                // notifications (notifications/initialized, ...) need no answer
                return error(-32601, "Method not found: " + message.method);
        }
    }

    function callTool(client, params, result, error) {
        var name = params.name;
        var args = params.arguments && typeof params.arguments == "object" ? params.arguments : {};
        if (typeof name != "string" || !TOOL_NAMES[name])
            return error(-32602, "Unknown tool: " + name);
        if (name == "getWorkspaceFolders") {
            return result(textResult(JSON.stringify({
                success: true,
                folders: [{ name: path.basename(workspaceDir), uri: "file://" + workspaceDir, path: workspaceDir }],
                rootPath: workspaceDir
            })));
        }
        if (!browser || silent)
            return result({ content: [{ type: "text", text: "The Cloud9 IDE is not connected" }], isError: true });

        var id = ++callId;
        var call = calls[id] = { client: client, result: result };
        if (!WAITING_TOOLS[name]) {
            call.timer = setTimeout(function() {
                if (!calls[id]) return;
                delete calls[id];
                emit({ ev: "cancel", id: id });
                result({ content: [{ type: "text", text: "The Cloud9 IDE did not answer" }], isError: true });
            }, CALL_TIMEOUT);
        }
        emit({ ev: "call", id: id, client: client.id, tool: name, args: args });
    }

    /***** The lock file *****/

    function writeLock(callback) {
        var data = JSON.stringify({
            pid: process.pid,
            workspaceFolders: [workspaceDir],
            ideName: "Cloud9",
            transport: "ws",
            runningInWindows: false,
            authToken: token
        });
        fs.mkdir(lockDir, { recursive: true, mode: 448 /* 0700 */ }, function(err) {
            if (err) return callback(err);
            lockFile = path.join(lockDir, port + ".lock");
            // not through a link someone left there
            fs.unlink(lockFile, function() {
                fs.writeFile(lockFile, data, { mode: 384 /* 0600 */, flag: "wx" }, function(err) {
                    // written at the same moment for a second request
                    callback(err && err.code != "EEXIST" ? err : null);
                });
            });
        });
    }

    // With two lock files for one folder the CLI does not choose. So the
    // IDE that was used last has the lock file: it removes those of other
    // Cloud9 bridges for this workspace (their CLIs stay connected, and
    // they write theirs again when their IDE is used). And those a Cloud9
    // that was killed left behind.
    function isRunning(pid) {
        try {
            process.kill(pid, 0);
            return true;
        } catch (e) {
            return e.code == "EPERM";
        }
    }

    function removeOtherLocks(callback) {
        fs.readdir(lockDir, function(err, names) {
            var pending = 1;
            function done() {
                if (--pending === 0) callback();
            }
            (names || []).forEach(function(name) {
                var file = path.join(lockDir, name);
                if (!/^\d+\.lock$/.test(name) || file == lockFile) return;
                pending++;
                fs.readFile(file, "utf8", function(err, text) {
                    var lock = null;
                    try { lock = JSON.parse(text); } catch (e) {}
                    if (lock && lock.ideName == "Cloud9" && lock.pid != process.pid
                      && Array.isArray(lock.workspaceFolders)
                      && (lock.workspaceFolders[0] == workspaceDir || !isRunning(lock.pid)))
                        return fs.unlink(file, done);
                    done();
                });
            });
            done();
        });
    }

    // The IDE in the browser got the focus
    function activate(callback) {
        callback = callback || function() {};
        if (!port || !browser) return callback(null, false);
        lastAlive = Date.now();
        silent = false;
        removeOtherLocks(function() {
            fs.stat(lockFile || "", function(err) {
                if (!err) return callback(null, true);
                writeLock(function(err) {
                    callback(err || null, !err);
                });
            });
        });
    }

    function removeLock() {
        if (!lockFile) return;
        try { fs.unlinkSync(lockFile); } catch (e) {}
    }

    /***** Start and stop *****/

    function start(callback) {
        if (port) return callback(null);
        if (starting) return starting.push(callback);
        starting = [callback];

        function done(err) {
            var waiting = starting;
            starting = null;
            if (err) {
                if (server) try { server.close(); } catch (e) {}
                server = port = null;
            }
            waiting.forEach(function(cb) { cb(err || null); });
        }

        server = http.createServer(function(req, res) {
            res.writeHead(426, { "Content-Length": 0, "Connection": "close" });
            res.end();
        });
        server.on("upgrade", onUpgrade);
        server.once("error", done);
        // a free port, on this machine only
        server.listen(0, "127.0.0.1", function() {
            server.removeListener("error", done);
            server.on("error", function(e) { console.error("[claude ide]", e); });
            port = server.address().port;
            done();
        });
    }

    // Stops the bridge (the user turned it off); connect() starts it again
    function stop(callback) {
        clearTimeout(absentTimer);
        clearInterval(aliveTimer);
        aliveTimer = null;
        removeLock();
        lockFile = null;
        clients.slice().forEach(function(client) {
            try { client.socket.destroy(); } catch (e) {}
        });
        if (server) try { server.close(); } catch (e) {}
        server = port = null;
        if (browser) browser.emit("end");
        browser = null;
        callback && callback();
    }

    // the process may end with the IDE's connection: leave no lock file
    // (the CLI also removes one whose process is gone)
    // One set of handlers per process, shared with the chat panel's service
    // (claude-service.js, which has the same lines): the vfs process is
    // ended with a signal when its IDE is gone.
    var KEY = "__c9ClaudeServiceCleanup";
    if (!process[KEY]) {
        var cleanups = process[KEY] = [];
        var runAll = function() {
            cleanups.slice().forEach(function(fn) {
                try { fn(); } catch (e) {}
            });
        };
        process.on("exit", runAll);
        ["SIGTERM", "SIGINT", "SIGHUP"].forEach(function(signal) {
            process.on(signal, function onSignal() {
                runAll();
                // keep the default behaviour (exit) unless someone else handles it
                if (process.listeners(signal).length <= 1)
                    process.exit(128 + (os.constants.signals[signal] || 15));
            });
        });
    }
    process[KEY].push(removeLock);

    /***** The IDE in the browser *****/

    function emit(event) {
        if (!browser) return;
        try {
            browser.emit("data", JSON.stringify(event));
        } catch (e) {}
    }

    // The lock file is there while an IDE is: without one a CLI would
    // connect to nobody. (The vfs outlives the page: it waits for the page
    // to come back, after a reload or a lost connection.)
    // what the CLIs wait for will not be answered
    function failCalls() {
        Object.keys(calls).forEach(function(id) {
            var call = calls[id];
            clearTimeout(call.timer);
            delete calls[id];
            call.result({ content: [{ type: "text", text: "The Cloud9 IDE went away" }], isError: true });
        });
    }

    // The vfs does not always say that the page is gone (its stream stays
    // open), so the page says that it is there
    function checkAlive() {
        var timeout = options.aliveTimeout === undefined ? ALIVE_TIMEOUT : options.aliveTimeout;
        if (!browser || silent || Date.now() - lastAlive < timeout) return;
        silent = true;
        failCalls();
        removeLock();
    }

    function alive(callback) {
        lastAlive = Date.now();
        // back (the computer slept): the lock file again
        if (silent) return activate(callback);
        callback = callback || function() {};
        if (!browser || !port) return callback(null, false);
        // The lock file went to another IDE of this workspace, which is
        // gone now: this one has it again
        fs.stat(lockFile || "", function(err) {
            if (!err) return callback(null, true);
            otherLock(function(other) {
                if (other || !browser || !port) return callback(null, true);
                writeLock(function(err) { callback(err || null, !err); });
            });
        });
    }

    // callback(true) if a Cloud9 that is running has a lock file for this
    // workspace
    function otherLock(callback) {
        fs.readdir(lockDir, function(err, names) {
            names = (names || []).filter(function(name) {
                return /^\d+\.lock$/.test(name) && path.join(lockDir, name) != lockFile;
            });
            (function next(i) {
                if (i >= names.length) return callback(false);
                fs.readFile(path.join(lockDir, names[i]), "utf8", function(err, text) {
                    var lock = null;
                    try { lock = JSON.parse(text); } catch (e) {}
                    if (lock && lock.ideName == "Cloud9" && Array.isArray(lock.workspaceFolders)
                      && lock.workspaceFolders[0] == workspaceDir && isRunning(lock.pid))
                        return callback(true);
                    next(i + 1);
                });
            })(0);
        });
    }

    function browserGone(stream) {
        if (browser !== stream) return;
        browser = null;
        failCalls();
        clearTimeout(absentTimer);
        absentTimer = setTimeout(function() {
            if (!browser) removeLock();
        }, options.absentGrace === undefined ? ABSENT_GRACE : options.absentGrace);
        if (absentTimer.unref) absentTimer.unref();
    }

    // callback(err, { stream, port, clients, lockFile })
    function connect(callback) {
        start(function(err) {
            if (err) return callback(err);
            if (browser) browser.emit("end");
            clearTimeout(absentTimer);
            var stream = browser = new Stream();
            stream.readable = true;
            stream.on("close", function() { browserGone(stream); });
            stream.on("end", function() { browserGone(stream); });
            if (!aliveTimer) {
                aliveTimer = setInterval(checkAlive, options.aliveCheck || 10000);
                if (aliveTimer.unref) aliveTimer.unref();
            }
            // this IDE is the one in use now
            activate(function(err) {
                if (err) return callback(err);
                callback(null, { stream: stream, port: port, clients: clients.length, lockFile: lockFile });
            });
        });
    }

    // The IDE's answer to a tool call: content is the list of MCP content
    // items, or an error text.
    function respond(id, err, content, callback) {
        var call = calls[id];
        if (call) {
            clearTimeout(call.timer);
            delete calls[id];
            if (err)
                call.result({ content: [{ type: "text", text: String(err) }], isError: true });
            else
                call.result({ content: Array.isArray(content) ? content : [] });
        }
        callback && callback(null, !!call);
    }

    // A notification of the IDE for the connected CLIs
    var NOTIFICATIONS = { selection_changed: true, at_mentioned: true };
    function notify(method, params, callback) {
        if (NOTIFICATIONS[method] && params && typeof params == "object") {
            clients.forEach(function(client) {
                client.send({ jsonrpc: "2.0", method: method, params: params });
            });
        }
        callback && callback(null, clients.length);
    }

    function status(callback) {
        callback(null, {
            port: port || null,
            lockFile: lockFile || null,
            workspaceDir: workspaceDir,
            clients: clients.map(function(c) { return { id: c.id, pid: c.pid }; })
        });
    }

    register(null, {
        connect: connect,
        respond: respond,
        notify: notify,
        activate: activate,
        alive: alive,
        status: status,
        stop: stop
    });
};

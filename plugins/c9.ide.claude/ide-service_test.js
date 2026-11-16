#!/usr/bin/env node
/*global describe it before after beforeEach afterEach */
"use strict";
"use server";

require("c9/inline-mocha")(module);

var assert = require("assert");
var fs = require("fs");
var http = require("http");
var os = require("os");
var path = require("path");

var service = require("./ide-service");
// a WebSocket client as small as the server
var connect = require("../../test/ws-client");

describe(__filename, function() {
    var tmp, lockDir, workspace, api, meta, events, onEvent, sockets;

    function start(options, callback) {
        service({ workspaceDir: options.workspaceDir || workspace }, Object.assign({ lockDir: lockDir, version: "test", absentGrace: 30 }, options.service), function(err, started) {
            assert.ok(!err);
            started.connect(function(err, startedMeta) {
                assert.ok(!err, err && err.message);
                callback(started, startedMeta);
            });
        });
    }

    function lock() {
        return JSON.parse(fs.readFileSync(meta.lockFile, "utf8"));
    }

    function open(callback) {
        connect(meta.port, { "x-claude-code-ide-authorization": lock().authToken }, function(err, client) {
            assert.ok(!err, err && err.message);
            assert.equal(client.status, 101);
            sockets.push(client.socket);
            callback(client);
        });
    }

    beforeEach(function(done) {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), "c9-claude-ide-"));
        lockDir = path.join(tmp, "config", "ide");
        workspace = path.join(tmp, "workspace");
        fs.mkdirSync(workspace);
        events = [];
        sockets = [];
        onEvent = null;
        start({}, function(started, startedMeta) {
            api = started;
            meta = startedMeta;
            meta.stream.on("data", function(chunk) {
                var event = JSON.parse(chunk);
                events.push(event);
                if (onEvent) onEvent(event);
            });
            done();
        });
    });

    afterEach(function(done) {
        sockets.forEach(function(socket) { socket.destroy(); });
        api.stop(function() {
            fs.rmSync(tmp, { recursive: true, force: true });
            done();
        });
    });

    describe("the lock file", function() {
        it("should be where the CLI looks, for this user only", function() {
            assert.equal(meta.lockFile, path.join(lockDir, meta.port + ".lock"));
            assert.equal(fs.statSync(meta.lockFile).mode & 511, 384 /* 0600 */);
            assert.equal(fs.statSync(lockDir).mode & 511, 448 /* 0700 */);
            var data = lock();
            assert.deepEqual(data.workspaceFolders, [workspace]);
            assert.equal(data.transport, "ws");
            assert.equal(data.ideName, "Cloud9");
            assert.equal(data.pid, process.pid);
            assert.ok(/^[0-9a-f]{64}$/.test(data.authToken));
        });

        it("should be removed when the bridge is stopped", function(done) {
            var file = meta.lockFile;
            start({ workspaceDir: path.join(tmp, "other") }, function(other, otherMeta) {
                assert.ok(fs.existsSync(otherMeta.lockFile));
                other.stop(function() {
                    assert.ok(!fs.existsSync(otherMeta.lockFile));
                    assert.ok(fs.existsSync(file));
                    done();
                });
            });
        });

        it("should be there while an IDE is: gone without one, back with it", function(done) {
            var file = meta.lockFile;
            meta.stream.emit("close");
            assert.ok(fs.existsSync(file), "a reload: not at once");
            setTimeout(function() {
                assert.ok(!fs.existsSync(file));
                api.activate(function(err, active) {
                    assert.ok(!active, "not written for a bridge without an IDE");
                    assert.ok(!fs.existsSync(file));
                    api.connect(function(err, again) {
                        assert.ok(!err);
                        assert.equal(again.port, meta.port);
                        assert.ok(fs.existsSync(file));
                        done();
                    });
                });
            }, 120);
        });

        it("should be gone when the IDE no longer says that it is there, and back when it does", function(done) {
            // a bridge of its own, that waits less long
            start({ workspaceDir: path.join(tmp, "impatient"), service: { aliveTimeout: 150, aliveCheck: 25 }}, function(impatient, itsMeta) {
                var first = api;
                api = impatient;
                meta = itsMeta;
                first.stop(function() { withBridge(); });
            });
            function withBridge() {
            var file = meta.lockFile;
            open(function(client) {
                // a diff the CLI waits for
                client.send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "openDiff", arguments: {
                    old_file_path: "/a", new_file_path: "/a", new_file_contents: "", tab_name: "t"
                }}});
                var keep = setInterval(function() { api.alive(); }, 20);
                setTimeout(function() {
                    assert.ok(fs.existsSync(file), "there while the IDE is");
                    clearInterval(keep);
                    client.next(function(m) {
                        assert.equal(m.result.isError, true);
                        assert.ok(!fs.existsSync(file));
                        client.request(2, "tools/call", { name: "getOpenEditors", arguments: {}}, function(m) {
                            assert.equal(m.result.isError, true);
                            api.alive(function(err, active) {
                                assert.ok(active);
                                assert.ok(fs.existsSync(file));
                                done();
                            });
                        });
                    });
                }, 300);
            });
            }
        });

        it("should come back to an IDE whose lock went to another IDE that is gone", function(done) {
            var file = meta.lockFile;
            // taken over by the bridge of an IDE that is used: stays away
            fs.unlinkSync(file);
            var other = path.join(lockDir, "4444.lock");
            fs.writeFileSync(other, JSON.stringify({ pid: process.ppid, ideName: "Cloud9", workspaceFolders: [workspace] }));
            api.alive(function() {
                assert.ok(!fs.existsSync(file));
                // that IDE is gone
                fs.unlinkSync(other);
                api.alive(function(err, active) {
                    assert.ok(active);
                    assert.ok(fs.existsSync(file));
                    done();
                });
            });
        });

        it("should come back when the bridge is turned off and on", function(done) {
            var file = meta.lockFile;
            open(function(client) {
                client.socket.on("close", function() {
                    assert.ok(!fs.existsSync(file));
                    api.connect(function(err, again) {
                        assert.ok(!err);
                        assert.ok(fs.existsSync(again.lockFile));
                        assert.notEqual(again.lockFile, file);
                        meta = again;
                        open(function(client) {
                            client.request(1, "ping", {}, function(m) {
                                assert.deepEqual(m.result, {});
                                done();
                            });
                        });
                    });
                });
                api.stop();
            });
        });

        it("should be the only one of Cloud9 for a workspace: the IDE used last has it", function(done) {
            // another editor's, another workspace's and one that is not a lock file
            var vscode = path.join(lockDir, "1111.lock");
            fs.writeFileSync(vscode, JSON.stringify({ pid: 1, ideName: "Visual Studio Code", workspaceFolders: [workspace] }));
            var elsewhere = path.join(lockDir, "2222.lock");
            fs.writeFileSync(elsewhere, JSON.stringify({ pid: 1, ideName: "Cloud9", workspaceFolders: ["/elsewhere"] }));
            var stale = path.join(lockDir, "3333.lock");
            fs.writeFileSync(stale, JSON.stringify({ pid: 1, ideName: "Cloud9", workspaceFolders: [workspace] }));
            var notes = path.join(lockDir, "notes.txt");
            fs.writeFileSync(notes, "x");

            api.activate(function(err, active) {
                assert.ok(!err);
                assert.ok(active);
                assert.ok(fs.existsSync(meta.lockFile));
                assert.ok(!fs.existsSync(stale), "another Cloud9 lock of this workspace");
                assert.ok(fs.existsSync(vscode));
                assert.ok(fs.existsSync(elsewhere));
                assert.ok(fs.existsSync(notes));

                // its own was removed (by the bridge of another IDE): written again
                fs.unlinkSync(meta.lockFile);
                api.activate(function(err, active) {
                    assert.ok(active);
                    assert.equal(lock().authToken.length, 64);
                    done();
                });
            });
        });
    });

    describe("a connection", function() {
        it("should be refused without the token of the lock file", function(done) {
            connect(meta.port, {}, function(err, res) {
                assert.equal(res.status, 401);
                connect(meta.port, { "x-claude-code-ide-authorization": "0".repeat(64) }, function(err, res) {
                    assert.equal(res.status, 401);
                    done();
                });
            });
        });

        it("should be refused from a page in a browser, also with the token", function(done) {
            connect(meta.port, {
                "x-claude-code-ide-authorization": lock().authToken,
                Origin: "http://evil.example"
            }, function(err, res) {
                assert.equal(res.status, 401);
                done();
            });
        });

        it("should not answer a request that is not a WebSocket", function(done) {
            http.get({ host: "127.0.0.1", port: meta.port, path: "/" }, function(res) {
                res.resume();
                assert.equal(res.statusCode, 426);
                done();
            });
        });

        it("should be accepted with the token, and take the mcp protocol if offered", function(done) {
            connect(meta.port, {
                "x-claude-code-ide-authorization": lock().authToken,
                "Sec-WebSocket-Protocol": "mcp"
            }, function(err, client) {
                sockets.push(client.socket);
                assert.equal(client.status, 101);
                assert.equal(client.headers["sec-websocket-protocol"], "mcp");
                done();
            });
        });
    });

    describe("the protocol", function() {
        it("should answer initialize, ping and tools/list", function(done) {
            open(function(client) {
                client.request(1, "initialize", { protocolVersion: "2025-03-26", capabilities: {}}, function(m) {
                    assert.equal(m.id, 1);
                    assert.equal(m.result.protocolVersion, "2025-03-26");
                    assert.equal(m.result.serverInfo.name, "Cloud9");
                    assert.ok(m.result.capabilities.tools);
                    // a notification gets no answer; the next answer is the ping's
                    client.send({ jsonrpc: "2.0", method: "notifications/initialized" });
                    client.request(2, "ping", {}, function(m) {
                        assert.equal(m.id, 2);
                        assert.deepEqual(m.result, {});
                        client.request(3, "tools/list", {}, function(m) {
                            var names = m.result.tools.map(function(t) { return t.name; });
                            ["openDiff", "close_tab", "closeAllDiffTabs", "getDiagnostics", "openFile"].forEach(function(name) {
                                assert.ok(names.indexOf(name) != -1, name);
                            });
                            m.result.tools.forEach(function(t) {
                                assert.equal(t.inputSchema.type, "object");
                            });
                            done();
                        });
                    });
                });
            });
        });

        it("should say so for a method or a tool it does not have", function(done) {
            open(function(client) {
                client.request(1, "nothing/here", {}, function(m) {
                    assert.equal(m.error.code, -32601);
                    client.request(2, "tools/call", { name: "runCommand", arguments: {}}, function(m) {
                        assert.equal(m.error.code, -32602);
                        done();
                    });
                });
            });
        });

        it("should tell the IDE who connected and who went away", function(done) {
            open(function(client) {
                onEvent = function(event) {
                    if (event.ev == "connected") {
                        assert.equal(event.pid, 4242);
                        client.socket.destroy();
                    }
                    if (event.ev == "clients" && event.count === 0) {
                        onEvent = null;
                        done();
                    }
                };
                client.send({ jsonrpc: "2.0", method: "ide_connected", params: { pid: 4242 }});
            });
        });

        it("should read a message in fragments, a long one, and answer a ping frame", function(done) {
            open(function(client) {
                var long = "x".repeat(70000);
                onEvent = function(event) {
                    if (event.ev != "call") return;
                    onEvent = null;
                    assert.equal(event.args.new_file_contents, long);
                    api.respond(event.id, null, [{ type: "text", text: "DIFF_REJECTED" }]);
                };
                client.sendFrame(0x9, Buffer.from("hi"));
                client.send({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "openDiff", arguments: {
                    old_file_path: "/a", new_file_path: "/a", new_file_contents: long, tab_name: "t"
                }}}, 3);
                client.next(function(m) {
                    assert.equal(m.id, 7);
                    assert.equal(m.result.content[0].text, "DIFF_REJECTED");
                    assert.equal(client.pong, "hi");
                    done();
                });
            });
        });
    });

    describe("tool calls", function() {
        it("should answer getWorkspaceFolders itself", function(done) {
            open(function(client) {
                client.request(1, "tools/call", { name: "getWorkspaceFolders", arguments: {}}, function(m) {
                    var result = JSON.parse(m.result.content[0].text);
                    assert.equal(result.folders[0].path, workspace);
                    assert.equal(events.filter(function(e) { return e.ev == "call"; }).length, 0);
                    done();
                });
            });
        });

        it("should relay a call to the IDE and its answer to the CLI", function(done) {
            open(function(client) {
                onEvent = function(event) {
                    if (event.ev != "call") return;
                    onEvent = null;
                    assert.equal(event.tool, "getDiagnostics");
                    assert.deepEqual(event.args, { uri: "file:///x/a.js" });
                    api.respond(event.id, null, [{ type: "text", text: "[]" }], function(err, known) {
                        assert.ok(known);
                        // a second answer is of no call
                        api.respond(event.id, null, [], function(err, known) {
                            assert.ok(!known);
                        });
                    });
                };
                client.request("a", "tools/call", { name: "getDiagnostics", arguments: { uri: "file:///x/a.js" }}, function(m) {
                    assert.equal(m.id, "a");
                    assert.deepEqual(m.result, { content: [{ type: "text", text: "[]" }] });
                    done();
                });
            });
        });

        it("should relay the IDE's error as the result of the tool", function(done) {
            open(function(client) {
                onEvent = function(event) {
                    if (event.ev != "call") return;
                    onEvent = null;
                    api.respond(event.id, "Cloud9 can't open that");
                };
                client.request(1, "tools/call", { name: "openFile", arguments: { filePath: "/etc/passwd" }}, function(m) {
                    assert.equal(m.result.isError, true);
                    assert.equal(m.result.content[0].text, "Cloud9 can't open that");
                    done();
                });
            });
        });

        it("should tell the IDE when the CLI that asked is gone", function(done) {
            open(function(client) {
                var id;
                onEvent = function(event) {
                    if (event.ev == "call") {
                        id = event.id;
                        client.socket.destroy();
                    }
                    if (event.ev == "cancel") {
                        onEvent = null;
                        assert.equal(event.id, id);
                        done();
                    }
                };
                client.send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "openDiff", arguments: {
                    old_file_path: "/a", new_file_path: "/a", new_file_contents: "", tab_name: "t"
                }}});
            });
        });

        it("should fail without an IDE", function(done) {
            meta.stream.emit("close");
            open(function(client) {
                client.request(1, "tools/call", { name: "getOpenEditors", arguments: {}}, function(m) {
                    assert.equal(m.result.isError, true);
                    done();
                });
            });
        });
    });

    describe("notifications of the IDE", function() {
        it("should reach every connected CLI", function(done) {
            open(function(first) {
                open(function(second) {
                    var selection = { text: "x", filePath: "/x/a.js", selection: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 }}};
                    api.notify("selection_changed", selection, function(err, count) {
                        assert.equal(count, 2);
                    });
                    first.next(function(m) {
                        assert.equal(m.method, "selection_changed");
                        assert.deepEqual(m.params, selection);
                        assert.equal(m.id, undefined);
                        second.next(function(m) {
                            assert.equal(m.method, "selection_changed");
                            done();
                        });
                    });
                });
            });
        });

        it("should be of the kinds the protocol has only", function(done) {
            open(function(client) {
                api.notify("tools/call", { name: "x" });
                api.notify("at_mentioned", { filePath: "/x/a.js", lineStart: 1, lineEnd: 2 });
                client.next(function(m) {
                    assert.equal(m.method, "at_mentioned");
                    done();
                });
            });
        });
    });
});

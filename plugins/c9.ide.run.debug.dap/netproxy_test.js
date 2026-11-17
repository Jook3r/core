#!/usr/bin/env node
/*global describe it before after beforeEach afterEach */
"use strict";
"use server";

require("c9/inline-mocha")(module);

var assert = require("assert");
var childProcess = require("child_process");
var fs = require("fs");
var net = require("net");
var path = require("path");

// The proxy is started the way the IDE does it: its source on one line,
// without comments, run with node -e (see getProxySource() in dap.js)
function proxySource(port) {
    return fs.readFileSync(path.join(__dirname, "netproxy.js"), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*/g, "")
        .replace(/[\n\r]/g, "")
        .replace(/\{DEBUGGED_PROCESS_PORT\}/, port)
        .replace(/\{DEBUGGED_PROCESS_HOST\}/, "127.0.0.1");
}

function frame(message) {
    var json = JSON.stringify(message);
    return "Content-Length: " + Buffer.byteLength(json, "utf8") + "\r\n\r\n" + json;
}

describe(__filename, function() {
    var adapter, adapterSocket, received, onMessage, port, proxy, clients;

    // a debug adapter that only notes what it gets
    function startAdapter(callback) {
        received = [];
        adapter = net.createServer(function(socket) {
            adapterSocket = socket;
            var buffer = Buffer.alloc(0);
            socket.on("data", function(data) {
                buffer = Buffer.concat([buffer, data]);
                for (;;) {
                    var end = buffer.indexOf("\r\n\r\n");
                    if (end < 0) return;
                    var length = +/Content-Length: (\d+)/.exec(buffer.slice(0, end).toString())[1];
                    if (buffer.length < end + 4 + length) return;
                    var message = JSON.parse(buffer.slice(end + 4, end + 4 + length).toString("utf8"));
                    buffer = buffer.slice(end + 4 + length);
                    received.push(message);
                    onMessage && onMessage(message);
                }
            });
            socket.on("error", function() {});
        });
        // the proxy listens on the next port: take two that are free
        (function listen(tries) {
            var candidate = 20000 + Math.floor(Math.random() * 20000);
            var probe = net.createServer();
            probe.once("error", function() { tries ? listen(tries - 1) : callback(new Error("no free port")); });
            probe.listen(candidate + 1, "127.0.0.1", function() {
                probe.close(function() {
                    adapter.once("error", function() { tries ? listen(tries - 1) : callback(new Error("no free port")); });
                    adapter.listen(candidate, "127.0.0.1", function() {
                        port = candidate;
                        callback();
                    });
                });
            });
        })(10);
    }

    // done(err) once the proxy has printed its ready mark
    function startProxy(done) {
        proxy = childProcess.spawn(process.execPath, ["-e", proxySource(port)], { stdio: ["ignore", "pipe", "pipe"] });
        var out = "";
        proxy.stdout.on("data", function(data) {
            out += data;
            if (out.indexOf("ß") != -1 && done) {
                var callback = done;
                done = null;
                callback();
            }
        });
        proxy.on("exit", function() {
            if (done) done(new Error("the proxy exited: " + out));
        });
    }

    // the IDE's side: onLine(message) for every line
    function connect(onLine) {
        var socket = net.connect(port + 1, "127.0.0.1");
        socket.setEncoding("utf8");
        var text = "";
        socket.on("data", function(data) {
            text += data;
            var lines = text.split("\n");
            text = lines.pop();
            lines.forEach(function(line) { onLine(JSON.parse(line)); });
        });
        socket.on("error", function() {});
        clients.push(socket);
        return socket;
    }

    beforeEach(function(done) {
        clients = [];
        onMessage = null;
        adapterSocket = null;
        startAdapter(function(err) {
            if (err) return done(err);
            startProxy(done);
        });
    });

    afterEach(function(done) {
        clients.forEach(function(socket) { socket.destroy(); });
        if (proxy) proxy.kill();
        if (adapterSocket) adapterSocket.destroy();
        adapter.close(function() { done(); });
    });

    it("tells a new connection that no session was started", function(done) {
        connect(function(message) {
            assert.deepEqual(message, { type: "proxy", started: false });
            done();
        });
    });

    it("frames the IDE's lines for the adapter, counted in bytes", function(done) {
        var request = { seq: 1, type: "request", command: "evaluate", arguments: { expression: "\"ß→é\" + name" } };
        onMessage = function(message) {
            assert.deepEqual(message, request);
            done();
        };
        var socket = connect(function() {});
        // in two pieces, with an empty line in between
        var line = JSON.stringify(request);
        socket.write("\n" + line.slice(0, 20));
        setTimeout(function() { socket.write(line.slice(20) + "\n"); }, 30);
    });

    it("gives the IDE one line for each of the adapter's messages", function(done) {
        var events = [
            { seq: 1, type: "event", event: "output", body: { output: "two\nlines ß→é\r\n" } },
            { seq: 2, type: "event", event: "stopped", body: { reason: "breakpoint", threadId: 1 } }
        ];
        var got = [];
        connect(function(message) {
            if (message.type == "proxy") {
                // both messages, cut in the middle of a character
                var data = Buffer.from(frame(events[0]) + frame(events[1]), "utf8");
                var cut = data.indexOf(Buffer.from("→", "utf8")) + 1;
                adapterSocket.write(data.slice(0, cut));
                return setTimeout(function() { adapterSocket.write(data.slice(cut)); }, 30);
            }
            got.push(message);
            if (got.length == 2) {
                assert.deepEqual(got, events);
                done();
            }
        });
    });

    it("keeps what the adapter says until the IDE is connected", function(done) {
        var event = { seq: 1, type: "event", event: "initialized" };
        var wait = setInterval(function() {
            if (!adapterSocket) return;
            clearInterval(wait);
            adapterSocket.write(frame(event));
            setTimeout(function() {
                var got = [];
                connect(function(message) {
                    got.push(message);
                    if (got.length == 2) {
                        assert.deepEqual(got, [{ type: "proxy", started: false }, event]);
                        done();
                    }
                });
            }, 50);
        }, 10);
    });

    it("tells a page that is loaded again that the session goes on", function(done) {
        onMessage = function() {
            first.destroy();
            setTimeout(function() {
                connect(function(message) {
                    assert.deepEqual(message, { type: "proxy", started: true });
                    done();
                });
            }, 50);
        };
        var first = connect(function() {});
        first.write(JSON.stringify({ seq: 1, type: "request", command: "initialize", arguments: {} }) + "\n");
    });

    it("exits when the adapter is gone", function(done) {
        var ended = false;
        var socket = connect(function(message) {
            if (message.type == "proxy") adapterSocket.destroy();
        });
        socket.on("close", function() { ended = true; });
        proxy.on("exit", function(code) {
            assert.equal(code, 0);
            setTimeout(function() {
                assert.ok(ended);
                done();
            }, 50);
        });
    });
});

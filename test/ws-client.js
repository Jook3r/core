/**
 * A WebSocket client for the tests of the Claude Code IDE bridge
 * (plugins/c9.ide.claude/ide-service.js), in the place of the `claude` CLI:
 * it can send the header the bridge asks for, which the WebSocket of Node.js
 * and of browsers can't. Masked text frames out, JSON messages in.
 *
 *   connect(port, headers, function(err, client) {
 *       client.status           101, or the status the server refused with
 *       client.send(message)    (message, n): in n fragments
 *       client.next(callback)   the next message
 *       client.request(id, method, params, callback)
 *       client.call(tool, args) a promise of the result of tools/call
 *       client.messages         what came and nobody asked for (notifications)
 *   })
 */
"use strict";

var crypto = require("crypto");
var http = require("http");

function connect(port, headers, callback) {
    var req = http.request({
        host: "127.0.0.1",
        port: port,
        path: "/",
        headers: Object.assign({
            Connection: "Upgrade",
            Upgrade: "websocket",
            "Sec-WebSocket-Version": "13",
            "Sec-WebSocket-Key": crypto.randomBytes(16).toString("base64")
        }, headers)
    });
    req.on("response", function(res) {
        res.resume();
        callback(null, { status: res.statusCode });
    });
    req.on("error", callback);
    req.on("upgrade", function(res, socket) {
        var client = { status: 101, headers: res.headers, socket: socket, messages: [], waiting: [] };
        var buffered = Buffer.alloc(0);
        socket.on("data", function(chunk) {
            buffered = Buffer.concat([buffered, chunk]);
            while (buffered.length >= 2) {
                var length = buffered[1] & 0x7f;
                var offset = 2;
                if (length == 126) {
                    if (buffered.length < 4) return;
                    length = buffered.readUInt16BE(2);
                    offset = 4;
                }
                else if (length == 127) {
                    if (buffered.length < 10) return;
                    length = buffered.readUInt32BE(6);
                    offset = 10;
                }
                if (buffered.length < offset + length) return;
                var opcode = buffered[0] & 0x0f;
                var payload = buffered.slice(offset, offset + length);
                buffered = buffered.slice(offset + length);
                if (opcode == 0x1) {
                    var message = JSON.parse(payload.toString("utf8"));
                    if (client.pending && client.pending[message.id]) {
                        var answered = client.pending[message.id];
                        delete client.pending[message.id];
                        answered(message);
                        continue;
                    }
                    var waiting = client.waiting.shift();
                    if (waiting) waiting(message);
                    else client.messages.push(message);
                }
                else if (opcode == 0xA) {
                    client.pong = payload.toString();
                }
            }
        });
        // one frame, or the text cut into the given number of fragments
        client.sendFrame = function(opcode, payload, fin) {
            var mask = crypto.randomBytes(4);
            var head;
            if (payload.length < 126) {
                head = Buffer.from([0, 0x80 | payload.length]);
            }
            else {
                head = Buffer.alloc(4);
                head[1] = 0x80 | 126;
                head.writeUInt16BE(payload.length, 2);
            }
            head[0] = (fin === false ? 0 : 0x80) | opcode;
            var masked = Buffer.from(payload);
            for (var i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];
            socket.write(Buffer.concat([head, mask, masked]));
        };
        client.send = function(message, fragments) {
            var payload = Buffer.from(JSON.stringify(message), "utf8");
            if (!fragments) return client.sendFrame(0x1, payload);
            var size = Math.ceil(payload.length / fragments);
            for (var i = 0; i < fragments; i++) {
                client.sendFrame(i ? 0x0 : 0x1, payload.slice(i * size, (i + 1) * size), i == fragments - 1);
            }
        };
        client.next = function(callback) {
            if (client.messages.length) return callback(client.messages.shift());
            client.waiting.push(callback);
        };
        client.request = function(id, method, params, callback) {
            client.send({ jsonrpc: "2.0", id: id, method: method, params: params });
            client.next(callback);
        };
        // answers to call() go to their callers, by id; the rest to next()
        var callId = 0;
        client.pending = {};
        client.call = function(tool, args) {
            return new Promise(function(resolve) {
                var id = "call" + (++callId);
                client.pending[id] = function(message) {
                    resolve(message.result || message);
                };
                client.send({ jsonrpc: "2.0", id: id, method: "tools/call", params: { name: tool, arguments: args || {}}});
            });
        };
        callback(null, client);
    });
    req.end();
}

module.exports = connect;


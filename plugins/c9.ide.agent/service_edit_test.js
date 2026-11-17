#!/usr/bin/env node
/*global describe it before after beforeEach afterEach */
"use strict";
"use server";

require("c9/inline-mocha")(module);

var assert = require("assert");
var childProcess = require("child_process");
var fs = require("fs");
var http = require("http");
var os = require("os");
var path = require("path");

var service = require("./service");

// The inline edit's request (edit() of the service), with the user's claude
// CLI against a mock of the Anthropic Messages API. Without the CLI the
// tests are skipped.
var CLAUDE = (function() {
    var found = childProcess.spawnSync("sh", ["-c", "command -v claude"], { encoding: "utf8" });
    return found.status === 0 ? found.stdout.trim() : null;
})();

describe(__filename, function() {
    this.timeout(60000);

    var tmp, mock, requests, answer, delay, api, savedEnv;
    var ENV = ["HOME", "DEEPSEEK_API_KEY", "DEEPSEEK_ANTHROPIC_BASE_URL", "DISABLE_AUTOUPDATER"];

    before(function(done) {
        if (!CLAUDE) return done();
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), "c9-edit-"));
        fs.mkdirSync(path.join(tmp, "workspace"));
        requests = [];
        mock = http.createServer(function(req, res) {
            var body = "";
            req.on("data", function(chunk) { body += chunk; });
            req.on("end", function() {
                var json = {};
                try { json = JSON.parse(body); } catch (e) {}
                if (req.url.indexOf("/v1/messages/count_tokens") === 0) {
                    res.writeHead(200, { "content-type": "application/json" });
                    return res.end(JSON.stringify({ input_tokens: 100 }));
                }
                if (req.url.indexOf("/v1/messages") !== 0) {
                    res.writeHead(404, { "content-type": "application/json" });
                    return res.end("{}");
                }
                requests.push({ auth: req.headers.authorization, body: json });
                if (answer.status) {
                    res.writeHead(answer.status, { "content-type": "application/json" });
                    return res.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid api key" } }));
                }
                var message = { id: "msg_test", type: "message", role: "assistant", model: json.model, content: [],
                    stop_reason: null, stop_sequence: null, usage: { input_tokens: 120, output_tokens: 0 } };
                res.writeHead(200, { "content-type": "text/event-stream" });
                var event = function(type, data) {
                    data.type = type;
                    res.write("event: " + type + "\ndata: " + JSON.stringify(data) + "\n\n");
                };
                event("message_start", { message: message });
                event("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
                var pieces = answer.text.match(/[\s\S]{1,10}/g) || [];
                (function next() {
                    if (res.destroyed) return;
                    if (pieces.length) {
                        event("content_block_delta", { index: 0, delta: { type: "text_delta", text: pieces.shift() } });
                        return setTimeout(next, delay);
                    }
                    event("content_block_stop", { index: 0 });
                    event("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 7 } });
                    event("message_stop", {});
                    res.end();
                })();
            });
        });
        mock.listen(0, "127.0.0.1", function() {
            savedEnv = {};
            ENV.forEach(function(name) { savedEnv[name] = process.env[name]; });
            process.env.HOME = path.join(tmp, "home");
            fs.mkdirSync(process.env.HOME);
            process.env.DEEPSEEK_API_KEY = "sk-test-edit-key";
            process.env.DEEPSEEK_ANTHROPIC_BASE_URL = "http://127.0.0.1:" + mock.address().port;
            process.env.DISABLE_AUTOUPDATER = "1";
            service({ workspaceDir: path.join(tmp, "workspace") }, { provider: "deepseek" }, function(err, started) {
                assert.ok(!err, err && err.message);
                api = started;
                done();
            });
        });
    });

    after(function(done) {
        if (!CLAUDE) return done();
        api.destroy();
        ENV.forEach(function(name) {
            if (savedEnv[name] == null) delete process.env[name];
            else process.env[name] = savedEnv[name];
        });
        mock.close(function() {
            fs.rmSync(tmp, { recursive: true, force: true });
            done();
        });
    });

    beforeEach(function() {
        answer = { text: "    return a + b;\n" };
        delay = 0;
        if (requests) requests.length = 0;
    });

    // the events of an edit: callback(events, id)
    function run(opts, callback, onStart) {
        api.edit(opts, function(err, meta) {
            if (err) return callback(err);
            var events = [];
            meta.stream.on("data", function(chunk) {
                events = events.concat(JSON.parse(chunk));
            });
            meta.stream.on("end", function() { callback(null, events, meta.id); });
            onStart && onStart(meta);
        });
    }

    function skip(test) {
        return function(done) {
            if (!CLAUDE) {
                console.log("      (skipped: the claude CLI is not installed)");
                return done();
            }
            test(done);
        };
    }

    it("answers with the selection's replacement, in pieces", skip(function(done) {
        run({
            instruction: "return the sum",
            path: "/math.js", language: "javascript",
            before: "function add(a, b) {\n",
            selection: "    return 0;\n",
            after: "}\n"
        }, function(err, events) {
            assert.ok(!err, err && err.message);
            var last = events[events.length - 1];
            assert.equal(last.ev, "done", JSON.stringify(last));
            assert.equal(last.text, "    return a + b;\n");
            assert.equal(last.usage.output, 7);
            var deltas = events.filter(function(e) { return e.ev == "delta"; });
            assert.ok(deltas.length > 1);
            assert.equal(deltas.map(function(e) { return e.text; }).join(""), last.text);

            // what was asked: the account's key, no tools, the code and the instruction
            var request = requests[requests.length - 1];
            assert.equal(request.auth, "Bearer sk-test-edit-key");
            assert.equal((request.body.tools || []).length, 0);
            assert.ok(/replaces the selection/.test(JSON.stringify(request.body.system)));
            var user = JSON.stringify(request.body.messages);
            assert.ok(user.indexOf("<selection>\\n    return 0;\\n\\n</selection>") != -1, user);
            assert.ok(user.indexOf("<before>\\nfunction add(a, b) {\\n\\n</before>") != -1, user);
            assert.ok(user.indexOf("<instruction>\\nreturn the sum\\n</instruction>") != -1, user);
            assert.ok(user.indexOf("<file path=\\\"/math.js\\\" language=\\\"javascript\\\">") != -1, user);
            done();
        });
    }));

    it("sends an earlier answer along when the instruction is about it", skip(function(done) {
        run({ instruction: "shorter", selection: "a\n", draft: "a longer answer\n" }, function(err, events) {
            assert.ok(!err, err && err.message);
            assert.equal(events[events.length - 1].ev, "done");
            var user = JSON.stringify(requests[requests.length - 1].body.messages);
            assert.ok(user.indexOf("<draft>\\na longer answer\\n\\n</draft>") != -1, user);
            done();
        });
    }));

    it("can be cancelled", skip(function(done) {
        answer = { text: new Array(200).join("a line of the answer\n") };
        delay = 50;
        var cancelled = false;
        run({ instruction: "write a lot", selection: "" }, function(err, events) {
            assert.ok(!err, err && err.message);
            assert.ok(cancelled);
            var last = events[events.length - 1];
            assert.equal(last.ev, "error");
            assert.equal(last.code, "ECANCELED");
            done();
        }, function(meta) {
            meta.stream.on("data", function() {
                if (cancelled) return;
                cancelled = true;
                api.cancelEdit(meta.id, function(err, found) {
                    assert.equal(found, true);
                });
            });
        });
    }));

    it("reports what the API refused", skip(function(done) {
        answer = { status: 401 };
        run({ instruction: "anything", selection: "x\n" }, function(err, events) {
            assert.ok(!err, err && err.message);
            var last = events[events.length - 1];
            assert.equal(last.ev, "error", JSON.stringify(last));
            assert.equal(last.code, "EAUTH", JSON.stringify(last));
            done();
        });
    }));

    it("refuses an edit without an instruction, and a selection that is too long", skip(function(done) {
        api.edit({ instruction: "  ", selection: "x" }, function(err) {
            assert.equal(err && err.code, "EINVAL");
            api.edit({ instruction: "x", selection: new Array(200002).join("x") }, function(err) {
                assert.equal(err && err.code, "ETOOLARGE");
                done();
            });
        });
    }));
});

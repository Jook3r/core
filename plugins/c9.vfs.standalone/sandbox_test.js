#!/usr/bin/env node
/*global describe it before after */
"use strict";
"use server";

require("c9/inline-mocha")(module);

var assert = require("assert");
var http = require("http");
var connect = require("connect");

var sandbox = require("./sandbox");

describe(__filename, function() {
    var options = { pages: ["/ide.html"] };

    function policy(pathname, statusCode, contentType, opts) {
        return sandbox.headers(pathname, statusCode, contentType, opts || options)["Content-Security-Policy"];
    }

    describe("headers", function() {
        it("should not sandbox the IDE's page, and keep it out of frames", function() {
            var headers = sandbox.headers("/ide.html", 200, "text/html", options);
            assert.equal(headers["Content-Security-Policy"], "frame-ancestors 'none'");
            assert.equal(headers["X-Frame-Options"], "DENY");
            assert.equal(policy("/ide.html", 200, "text/html; charset=utf-8"), "frame-ancestors 'none'");
        });

        it("should sandbox what else is at the address of the IDE's page", function() {
            // an error repeats part of the request; ?config=1 is JSON
            assert.equal(policy("/ide.html", 422, "text/html"), sandbox.SANDBOX);
            assert.equal(policy("/ide.html", 500, "text/html"), sandbox.SANDBOX);
            assert.equal(policy("/ide.html", 401, undefined), sandbox.SANDBOX);
            assert.equal(policy("/ide.html", 200, "application/json"), sandbox.SANDBOX);
        });

        it("should sandbox the IDE's page at another path", function() {
            assert.equal(policy("/./ide.html", 200, "text/html"), sandbox.SANDBOX);
            assert.equal(policy("//ide.html", 200, "text/html"), sandbox.SANDBOX);
            assert.equal(policy("/IDE.html", 200, "text/html"), sandbox.SANDBOX);
            assert.equal(policy("/static/ide.html", 200, "text/html"), sandbox.SANDBOX);
        });

        it("should sandbox documents: files of the workspace, listings, the IDE's static pages", function() {
            [
                ["/preview/index.html", "text/html"],
                ["/preview/", "text/html"],
                ["/preview/page.xhtml", "application/xhtml+xml"],
                ["/preview/image.svg", "image/svg+xml"],
                ["/preview/data.xml", "application/xml"],
                ["/vfs/1/preview/index.html", "text/html"],
                ["/vfs/1/9cggBpZTLuTa7Mo2/workspace/index.html", "text/html"],
                ["/static/plugins/c9.ide.preview.markdown/markdown.html", "text/html; charset=UTF-8"],
                ["/static/test.html", "text/html; charset=UTF-8"]
            ].forEach(function(response) {
                assert.equal(policy(response[0], 200, response[1]), sandbox.SANDBOX, response[0]);
            });
        });

        it("should sandbox a response without a type, or of an unknown one", function() {
            assert.equal(policy("/preview/file", 200, undefined), sandbox.SANDBOX);
            assert.equal(policy("/preview/file", 200, ""), sandbox.SANDBOX);
            assert.equal(policy("/preview/file", 200, "application/octet-stream"), sandbox.SANDBOX);
            assert.equal(policy("/preview/file", 200, "text/x-error"), sandbox.SANDBOX);
        });

        it("should not sandbox scripts (the IDE's workers) and PDF", function() {
            assert.equal(policy("/static/standalone/worker/plugins/c9.ide.language.core/worker.js", 200, "application/javascript"), undefined);
            assert.equal(policy("/static/mini_require.js", 200, "application/javascript; charset=UTF-8"), undefined);
            assert.equal(policy("/static/x.js", 200, "text/javascript"), undefined);
            assert.equal(policy("/preview/doc.pdf", 200, "application/pdf"), undefined);
        });

        it("should never allow the IDE's origin in the sandbox", function() {
            assert.ok(/^sandbox /.test(sandbox.SANDBOX));
            assert.ok(/ allow-scripts( |$)/.test(sandbox.SANDBOX));
            assert.ok(!/allow-same-origin/.test(sandbox.SANDBOX));
            assert.ok(!/allow-top-navigation/.test(sandbox.SANDBOX));
        });

        it("should give \"not modified\" the headers of the file", function() {
            assert.equal(policy("/preview/index.html", 304, undefined), sandbox.SANDBOX);
            assert.equal(policy("/preview/file", 304, undefined), sandbox.SANDBOX);
            assert.equal(policy("/static/mini_require.js", 304, undefined), undefined);
            assert.equal(policy("/preview/doc.pdf", 304, undefined), undefined);
        });

        it("should let the IDE's pages show each other in a frame only when asked", function() {
            var testing = { pages: ["/ide.html", "/static/test.html"], framed: true };
            assert.equal(policy("/static/test.html", 200, "text/html", testing), "frame-ancestors 'self'");
            assert.equal(sandbox.headers("/ide.html", 200, "text/html", testing)["X-Frame-Options"], "SAMEORIGIN");
            assert.equal(policy("/preview/index.html", 200, "text/html", testing), sandbox.SANDBOX);
        });
    });

    describe("middleware", function() {
        var server, port;

        before(function(done) {
            var app = connect();
            app.use(sandbox(options));
            app.use(function(req, res, next) {
                var path = req.url.split("?")[0];
                if (req.url == "/ide.html?fail") {
                    // the status as an argument, as frontdoor and the error
                    // handler pass it
                    res.writeHead(422, { "Content-Type": "text/html" });
                    res.end("<script>alert(1)</script>");
                }
                else if (path == "/ide.html" || path == "/preview/index.html") {
                    res.writeHead(200, { "Content-Type": "text/html" });
                    res.end("<html></html>");
                }
                else if (path == "/implicit.html") {
                    res.setHeader("Content-Type", "text/html");
                    res.end("<html></html>");
                }
                else if (path == "/own.html") {
                    res.setHeader("Content-Security-Policy", "default-src 'self'");
                    res.setHeader("Content-Type", "text/html");
                    res.end("<html></html>");
                }
                else if (path == "/script.js") {
                    res.setHeader("Content-Type", "application/javascript");
                    res.end("1");
                }
                else if (path == "/cached.html") {
                    res.statusCode = 304;
                    res.end();
                }
                else {
                    next();
                }
            });
            server = http.createServer(app).listen(0, "127.0.0.1", function() {
                port = server.address().port;
                done();
            });
        });

        after(function(done) {
            server.close(done);
        });

        function get(path, callback) {
            http.get({ host: "127.0.0.1", port: port, path: path }, function(res) {
                res.resume();
                res.on("end", function() {
                    callback(res.statusCode, res.headers);
                });
            });
        }

        it("should leave the IDE's page without a sandbox", function(done) {
            get("/ide.html?w=/tmp", function(status, headers) {
                assert.equal(status, 200);
                assert.equal(headers["content-security-policy"], "frame-ancestors 'none'");
                assert.equal(headers["x-frame-options"], "DENY");
                done();
            });
        });

        it("should sandbox an error at the address of the IDE's page", function(done) {
            get("/ide.html?fail", function(status, headers) {
                assert.equal(status, 422);
                assert.equal(headers["content-security-policy"], sandbox.SANDBOX);
                assert.equal(headers["x-frame-options"], undefined);
                done();
            });
        });

        it("should sandbox a page, also when its headers are written by end()", function(done) {
            get("/preview/index.html", function(status, headers) {
                assert.equal(headers["content-security-policy"], sandbox.SANDBOX);
                get("/implicit.html", function(status, headers) {
                    assert.equal(headers["content-security-policy"], sandbox.SANDBOX);
                    done();
                });
            });
        });

        it("should sandbox \"not modified\" and \"not found\"", function(done) {
            get("/cached.html", function(status, headers) {
                assert.equal(status, 304);
                assert.equal(headers["content-security-policy"], sandbox.SANDBOX);
                get("/nothing/here", function(status, headers) {
                    assert.equal(status, 404);
                    // next to the policy connect gives its own "not found"
                    assert.equal(headers["content-security-policy"], "default-src 'none', " + sandbox.SANDBOX);
                    done();
                });
            });
        });

        it("should keep a policy of the response's own next to the sandbox", function(done) {
            get("/own.html", function(status, headers) {
                assert.equal(headers["content-security-policy"], "default-src 'self', " + sandbox.SANDBOX);
                done();
            });
        });

        it("should not sandbox a script", function(done) {
            get("/script.js", function(status, headers) {
                assert.equal(headers["content-security-policy"], undefined);
                done();
            });
        });
    });
});

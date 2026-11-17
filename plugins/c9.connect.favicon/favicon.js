"use strict";

plugin.consumes = [
    "connect"
];
plugin.provides = [
    "connect.favicon"
];

module.exports = plugin;

var crypto = require("crypto");
var fs = require("fs");

function plugin(options, imports, register) {
    var connect = imports.connect;

    var icon = options.path || __dirname + "/favicon.ico";
    var maxAge = options.maxAge == null ? 24 * 60 * 60 * 1000 : options.maxAge;
    var cached;
    connect.useStart(function(req, res, next) {
        if (req.url.split("?")[0] != "/favicon.ico")
            return next();
        if (req.method != "GET" && req.method != "HEAD") {
            res.writeHead(req.method == "OPTIONS" ? 200 : 405, { "Allow": "GET, HEAD, OPTIONS", "Content-Length": "0" });
            return res.end();
        }
        if (cached)
            return send(cached);
        fs.readFile(icon, function(err, body) {
            if (err) return next(err);
            cached = {
                body: body,
                etag: '"' + crypto.createHash("sha1").update(body).digest("base64") + '"'
            };
            send(cached);
        });

        function send(file) {
            res.setHeader("ETag", file.etag);
            res.setHeader("Cache-Control", "public, max-age=" + Math.floor(maxAge / 1000));
            if (req.headers["if-none-match"] == file.etag) {
                res.statusCode = 304;
                return res.end();
            }
            res.setHeader("Content-Type", "image/x-icon");
            res.setHeader("Content-Length", file.body.length);
            res.end(req.method == "HEAD" ? undefined : file.body);
        }
    });

    register(null, {
        "connect.favicon": {}
    });
}
"use strict";

/**
 * Which of the server's responses may be the IDE in the browser.
 *
 * Everything this server sends has one origin, the IDE's. A document with
 * that origin can do what the user can: it reaches the IDE in the window
 * around it (window.app), and the browser adds the login to its requests to
 * the server, which reads and writes files and runs commands. So only the
 * IDE's own page is sent as such a document. Every other response a browser
 * may show as a document gets a sandbox, in which its scripts run with an
 * origin of their own: a file of the workspace in the preview (or opened by
 * its address), a folder listing, an error page, and the pages among the
 * IDE's static files, which were not written to be safe against whoever
 * opens them.
 *
 * What a page loses in the sandbox: see "Previews" in the README.
 */

var mime = require("mime");
var onHeaders = require("on-headers");

// No allow-same-origin: that is the point. No allow-top-navigation: a page
// in the preview can't replace the IDE around it. The preview's frame has a
// sandbox of its own as well (plugins/c9.ide.preview.browser/browser.js).
var SANDBOX = "sandbox allow-scripts allow-forms allow-modals allow-pointer-lock"
    + " allow-popups allow-popups-to-escape-sandbox allow-downloads";

// The IDE's page: no page can show it in a frame (another site to have
// its buttons clicked, a page in the preview to get an IDE of its own)
var APP = {
    "Content-Security-Policy": "frame-ancestors 'none'",
    "X-Frame-Options": "DENY"
};
// (the page of the client-side tests shows itself in a frame)
var APP_FRAMED = {
    "Content-Security-Policy": "frame-ancestors 'self'",
    "X-Frame-Options": "SAMEORIGIN"
};

// Not sandboxed: scripts, as a browser may put a worker in the sandbox of
// its script and the IDE's workers need the IDE's origin (shown as a
// document a script is text); and PDF, which browsers don't display in a
// sandbox (the scripts of a PDF don't run in a page)
var PLAIN = /^(?:(?:application|text)\/(?:x-)?(?:javascript|ecmascript)|application\/pdf)$/;

/**
 * The headers to add to a response.
 *
 * @param {String}  pathname        the path of the request, without the query
 * @param {Number}  statusCode      of the response
 * @param {String}  contentType     of the response, if it has one
 * @param {Object}  options
 * @param {Array}   options.pages   the paths of the IDE's own pages
 * @param {Boolean} options.framed  whether they may show each other in a frame
 */
function headers(pathname, statusCode, contentType, options) {
    var type = String(contentType || "").split(";")[0].trim().toLowerCase();

    // "Not modified" comes without a type and its headers replace those the
    // browser kept: send what the file itself would get
    if (!type && statusCode == 304)
        type = mime.lookup(pathname);

    // only the page itself: an error at its address repeats part of the
    // request
    if (options.pages.indexOf(pathname) != -1 && (statusCode == 200 || statusCode == 304)
      && type == "text/html")
        return options.framed ? APP_FRAMED : APP;

    if (PLAIN.test(type))
        return {};

    return { "Content-Security-Policy": SANDBOX };
}

/**
 * Connect middleware that adds them to every response.
 *
 * @param {Object} options  as for headers()
 */
function middleware(options) {
    return function(req, res, next) {
        // the path as the browser asked for it: a page of the IDE asked for
        // in another way ("/./ide.html") gets the sandbox
        var pathname = String(req.url).split("?")[0];

        // right before the headers are written, when the status and the
        // type are known (also those passed to writeHead)
        onHeaders(res, function() {
            var add;
            try {
                add = headers(pathname, res.statusCode, res.getHeader("Content-Type"), options);
            } catch (e) {
                add = { "Content-Security-Policy": SANDBOX };
            }
            for (var name in add) {
                var value = add[name];
                // a policy of the response's own stays: browsers apply both
                var own = name == "Content-Security-Policy" && res.getHeader(name);
                res.setHeader(name, own ? [].concat(own, value) : value);
            }
        });
        next();
    };
}

module.exports = middleware;
module.exports.headers = headers;
module.exports.SANDBOX = SANDBOX;

#!/usr/bin/env node
/**
 * Runs test files of the Ace editor (plugins/node_modules/ace) with Ace's
 * own test runner and mock DOM, for the parts Cloud9 changed:
 *
 *   node test/ace-test.js plugins/node_modules/ace/lib/ace/virtual_renderer_test.js
 *
 * Exits with 1 when a test fails.
 */
"use strict";

var path = require("path");
var Module = require("module");

var ACE = path.join(__dirname, "../plugins/node_modules/ace/lib");
// amd-loader, Ace's modules as "ace/...", and its runner as "asyncjs"
process.env.NODE_PATH = [path.join(__dirname, "../node_modules"), ACE, path.join(ACE, "ace/test")]
    .join(path.delimiter);
Module._initPaths();

// Node.js 21 and later have a navigator of their own, without what Ace's
// user agent sniffing (ace/lib/useragent) reads
Object.defineProperty(globalThis, "navigator", {
    value: { userAgent: "Mozilla/5.0 (X11; Linux x86_64) Node.js", platform: "Linux", appName: "Netscape" },
    configurable: true,
    writable: true
});

require("amd-loader");
var asyncjs = require("asyncjs");
var files = process.argv.slice(2);
var failed = 0;

(function next(i) {
    // the editors' render loops keep timers going
    if (i == files.length) process.exit(failed ? 1 : 0);
    var tests = require(path.resolve(files[i]));
    asyncjs.test.testcase(tests, files[i]).run().report().summary(function(err, passed) {
        if (err || !passed) failed++;
        next(i + 1);
    });
})(0);

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
// amd-loader. Not Ace's modules as "ace/...": Ace asks for a mode by such
// a name first, and where that fails loads it later, which its tests expect
process.env.NODE_PATH = path.join(__dirname, "../node_modules");
Module._initPaths();

// Node.js 21 and later have a navigator of their own, without what Ace's
// user agent sniffing (ace/lib/useragent) reads
Object.defineProperty(globalThis, "navigator", {
    value: { userAgent: "Mozilla/5.0 (X11; Linux x86_64) Node.js", platform: "Linux", appName: "Netscape" },
    configurable: true,
    writable: true
});

require("amd-loader");
// Ace's stand-in for the browser (window, document): with a navigator, Ace
// takes itself to be in a browser, also in the tests that ask for no DOM
require(path.join(ACE, "ace/test/mockdom"));
// Ace's runner; each test file hands itself to it (as a file that was not
// started by itself, without effect), so the suites are collected here
var runner = require(path.join(ACE, "ace/test/run"));
var suites = process.argv.slice(2).map(function(file) {
    var suite = require(path.resolve(file));
    suite.name = file;
    return suite;
});

runner.watchErrors();
runner.prepareSteps(suites, "");
// exits when done, with 1 if a test failed
runner.runSteps();

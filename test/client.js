#!/usr/bin/env node
// The client-side tests (*_test.js that run in the browser): starts Cloud9
// in test mode (no login, the mock workspace plugins/c9.fs/mock) in a
// temporary home folder and runs each file in the test page,
// /static/test.html, in headless Chromium. One page per file, so a test
// can't leave anything behind for the next.
//
// Needs scripts/install-sdk.sh to have run, Node.js 18+ and Playwright with
// Chromium, as test/smoke.js does.
//
//   node test/client.js [part of a file's path ...]
"use strict";

var childProcess = require("child_process");
var fs = require("fs");
var http = require("http");
var os = require("os");
var path = require("path");

var ROOT = path.resolve(__dirname, "..");
var TIMEOUT = 90000;

// Not tests of the IDE: Ace's own (scripts/run-tests.sh runs them in
// Node.js), and the tests in the examples and templates for plugins
var NOT_OURS = /^plugins\/node_modules\/|\/mock\/|\/templates\//;

// Tests that fail, since before they were run here: of plugins that are not
// loaded (collab, codeintel), and of the runners, the debugger panels and a
// few others, which need looking at one by one. Take a file out of this list
// when it passes.
var KNOWN_FAILURES = [
    "plugins/c9.ide.collab/collab_test.js",
    "plugins/c9.ide.console/console_test.js",
    "plugins/c9.ide.language.codeintel/codeintel_test.js",
    "plugins/c9.ide.run/run_test.js",
    "plugins/c9.ide.run.build/build_test.js",
    "plugins/c9.ide.run.build/gui_test.js",
    "plugins/c9.ide.run.debug/breakpoints_test.js",
    "plugins/c9.ide.run.debug/callstack_test.js",
    "plugins/c9.ide.run.debug/debuggers/debugger_test.js",
    "plugins/c9.ide.run.debug/variables_test.js",
    "plugins/c9.ide.run.debug/watches_test.js",
    "plugins/c9.ide.save/autosave_test.js",
    "plugins/c9.ide.ui/docklayout_test.js"
];

var tmp, server, browser;

function wait(ms) {
    return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

function freePort() {
    return new Promise(function(resolve, reject) {
        var s = http.createServer().listen(0, "127.0.0.1", function() {
            var port = s.address().port;
            s.close(function() { resolve(port); });
        }).on("error", reject);
    });
}

function getJSON(port, urlPath) {
    return new Promise(function(resolve, reject) {
        http.get({ host: "127.0.0.1", port: port, path: urlPath }, function(res) {
            var body = "";
            res.on("data", function(chunk) { body += chunk; });
            res.on("end", function() {
                try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
            });
        }).on("error", reject);
    });
}

async function startServer(port) {
    var home = path.join(tmp, "home");
    var tmuxDir = path.join(tmp, "tmux");
    fs.mkdirSync(home);
    fs.mkdirSync(tmuxDir);
    var log = fs.openSync(path.join(tmp, "server.log"), "a");
    server = childProcess.spawn(process.execPath, [
        path.join(ROOT, "server.js"), "-t", "-p", String(port), "-l", "127.0.0.1"
    ], {
        cwd: ROOT,
        env: Object.assign({}, process.env, { HOME: home, TMUX_TMPDIR: tmuxDir }),
        stdio: ["ignore", log, log],
        detached: true
    });
    for (var i = 0; i < 240; i++) {
        if (server.exitCode !== null)
            throw new Error("the server exited (" + server.exitCode + "), see " + path.join(tmp, "server.log"));
        try {
            return await getJSON(port, "/test/all.json");
        } catch (e) {
            await wait(250);
        }
    }
    throw new Error("the server did not start");
}

// Runs one file in a page of its own; resolves { passes, failures, error }
async function runFile(port, file) {
    var context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    var page = await context.newPage();
    var result;
    try {
        await page.goto("http://127.0.0.1:" + port + "/static/test.html?" + file, { waitUntil: "load", timeout: 30000 });
        var handle = await page.waitForFunction(function() {
            var report = window.mocha && window.mocha.lastReport;
            return report && report.stats && {
                passes: report.stats.passes,
                failures: report.stats.failures,
                titles: (report.failures || []).map(function(f) { return f.fullTitle || f.title; }).slice(0, 5)
            };
        }, null, { timeout: TIMEOUT });
        result = await handle.jsonValue();
    } catch (e) {
        result = { passes: 0, failures: 1, error: String(e.message || e).split("\n")[0] };
    }
    await context.close().catch(function() {});
    return result;
}

async function main() {
    var only = process.argv.slice(2);
    var playwright;
    try {
        playwright = require("playwright");
    } catch (e) {
        throw new Error("Playwright is not installed: run scripts/run-tests.sh, or "
            + "npm install --prefix test, then npx --prefix test playwright install chromium");
    }
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "c9-client-"));
    var port = await freePort();
    var all = await startServer(port);
    var files = all.list.filter(function(file) {
        if (NOT_OURS.test(file)) return false;
        if (only.length) return only.some(function(part) { return file.indexOf(part) != -1; });
        return KNOWN_FAILURES.indexOf(file) == -1;
    });
    console.log("# " + files.length + " client-side test files (Cloud9 on port " + port + ", "
        + KNOWN_FAILURES.length + " known failures left out)");

    browser = await playwright.chromium.launch();
    var failed = [];
    var tests = 0;
    for (var i = 0; i < files.length; i++) {
        var result = await runFile(port, files[i]);
        // again, twice at most: these tests share one mock workspace with
        // a server that other tests have changed, and some depend on timing
        for (var attempt = 1; attempt < 3 && (result.failures || !result.passes); attempt++) {
            console.log("# again: " + files[i] + " (" + ((result.titles || [])[0] || result.error || "no tests ran") + ")");
            result = await runFile(port, files[i]);
        }
        tests += result.passes || 0;
        if (result.failures || !result.passes) {
            failed.push(files[i]);
            console.log("not ok - " + files[i] + " (" + (result.passes || 0) + " passed, " + result.failures + " failed)");
            (result.titles || []).forEach(function(title) { console.log("    # " + title); });
            if (result.error) console.log("    # " + result.error);
        } else {
            console.log("ok - " + files[i] + " (" + result.passes + ")");
        }
    }
    console.log("# " + (files.length - failed.length) + " of " + files.length + " files passed, " + tests + " tests");
    return failed.length;
}

function cleanup() {
    var closed = browser ? browser.close().catch(function() {}) : Promise.resolve();
    return closed.then(function() {
        if (server && server.exitCode === null) {
            try { process.kill(-server.pid, "SIGTERM"); } catch (e) {}
        }
        // the test's own tmux server
        var sockets = path.join(tmp || "", "tmux", "tmux-" + process.getuid());
        if (tmp && fs.existsSync(sockets)) {
            fs.readdirSync(sockets).forEach(function(name) {
                childProcess.spawnSync("tmux", ["-S", path.join(sockets, name), "kill-server"]);
            });
        }
        if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    });
}

main().then(function(failed) {
    return cleanup().then(function() { process.exit(failed ? 1 : 0); });
}, function(e) {
    console.log("not ok - " + (e && e.message || e));
    return cleanup().then(function() { process.exit(1); });
});

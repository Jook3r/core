#!/usr/bin/env node
/**
 * Replaces the editor's sources, plugins/node_modules/ace/lib/ace, by those
 * of a checkout of Ace (https://github.com/ajaxorg/ace) at a release tag:
 *
 *   git clone --depth 1 --branch v1.45.2 https://github.com/ajaxorg/ace /tmp/ace
 *   scripts/vendor-ace.js /tmp/ace
 *
 * Ace's sources (src/) are CommonJS modules since 1.5; its own build wraps
 * them for a browser. Cloud9 loads each of them by its name (ace/editor,
 * ace/lib/oop, ...) with an AMD loader, so they are wrapped in define() here,
 * one file a module, with nothing else changed. The few sources Ace still
 * keeps as AMD modules (lib/ace: the worker, coffee, xquery) are copied as
 * they are.
 *
 * Cloud9's own changes to Ace are then applied from
 * plugins/node_modules/ace/cloud9.patch (described in CLOUD9.md there). Where
 * a newer Ace no longer takes one of them, patch says which. After changing
 * Ace here, write the patch again:
 *
 *   scripts/vendor-ace.js /tmp/ace /tmp/ace-plain
 *   (cd plugins/node_modules/ace && diff -ruN /tmp/ace-plain/lib lib \
 *       | sed "s#^--- /tmp/ace-plain/#--- a/#; s#^+++ lib/#+++ b/lib/#" > cloud9.patch)
 */
"use strict";

var fs = require("fs");
var path = require("path");

var from = process.argv[2];
if (!from || !fs.existsSync(path.join(from, "src/ace.js"))) {
    console.error("Usage: scripts/vendor-ace.js <checkout of ajaxorg/ace, 1.5 or newer>");
    process.exit(1);
}
var ace = path.join(__dirname, "../plugins/node_modules/ace");
// (a second argument: another folder to write lib/ace to, without Cloud9's
// changes, to compare with)
var plain = process.argv[3];
var to = plain ? path.join(plain, "lib/ace") : path.join(ace, "lib/ace");

// Left out, as before: the parsers of two linters that run in Ace's own
// workers, which Cloud9 doesn't use (it has its language worker), 7 MB
// (and a placeholder in src/ for the worker's client, which is in lib/ace)
var SKIP = /^lib\/ace\/mode\/(coffee|xquery\/xqlint\.js|coffee_worker\.js|xquery_worker\.js)$|^src\/worker\/worker_client\.js$/;

var HEAD = "define(function(require, exports, module) {\n";
var TAIL = "\n});\n";

function copy(dir, target, wrap) {
    var count = 0;
    fs.mkdirSync(target, { recursive: true });
    fs.readdirSync(dir, { withFileTypes: true }).forEach(function(entry) {
        var source = path.join(dir, entry.name);
        var dest = path.join(target, entry.name);
        if (SKIP.test(path.relative(from, source).split(path.sep).join("/")))
            return;
        if (entry.isDirectory()) {
            count += copy(source, dest, wrap);
        }
        else if (wrap && /\.js$/.test(entry.name)) {
            var code = fs.readFileSync(source, "utf8");
            if (/^define\(/m.test(code))
                throw new Error("already an AMD module: " + source);
            fs.writeFileSync(dest, HEAD + code.replace(/\s+$/, "") + TAIL);
            count++;
        }
        else {
            fs.copyFileSync(source, dest);
            count++;
        }
    });
    return count;
}

fs.rmSync(to, { recursive: true, force: true });
var amd = copy(path.join(from, "lib/ace"), to, false);
var wrapped = copy(path.join(from, "src"), to, true);

// The modes that have snippets, for Cloud9 to ask only for those
// (plugins/c9.ide.language.generic/snippet_loader.js)
var snippets = fs.readdirSync(path.join(to, "snippets")).filter(function(name) {
    return /\.js$/.test(name) && !/\.snippets\.js$/.test(name) && name != "c9_list.js";
}).map(function(name) {
    return name.slice(0, -3);
}).sort();
fs.writeFileSync(path.join(to, "snippets/c9_list.js"), HEAD
    + "// written by scripts/vendor-ace.js: the modes that have snippets\n"
    + "module.exports = " + JSON.stringify(snippets, null, 4) + ";" + TAIL);

if (plain) {
    console.log("Ace without Cloud9's changes: " + to);
    process.exit(0);
}

// Cloud9's own changes
var patch = path.join(ace, "cloud9.patch");
require("child_process").execFileSync("patch", ["-p1", "--no-backup-if-mismatch", "-d", ace, "-i", patch], { stdio: "inherit" });

var version = JSON.parse(fs.readFileSync(path.join(from, "package.json"), "utf8")).version;
var packagePath = path.join(ace, "package.json");
var packageJson = fs.readFileSync(packagePath, "utf8");
fs.writeFileSync(packagePath, packageJson.replace(/("version":\s*")[^"]*"/, "$1" + version + '"'));
["LICENSE", "CHANGELOG.md", "ace.d.ts"].forEach(function(name) {
    if (fs.existsSync(path.join(from, name)))
        fs.copyFileSync(path.join(from, name), path.join(ace, name));
});

console.log("Ace " + version + ": " + wrapped + " files from src/, " + amd + " from lib/ace");

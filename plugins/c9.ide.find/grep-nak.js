#!/usr/bin/env node
/**
 * Drop-in replacement for nak using grep/find.
 * Accepts nak's --json <args> interface and outputs nak-compatible format.
 */
"use strict";

var childProcess = require("child_process");
var fs = require("fs");
var path = require("path");

var args = process.argv.slice(2);
if (args[0] !== "--json") {
    process.stderr.write("Usage: grep-nak.js --json <json>\n");
    process.exit(1);
}

var options;
try {
    options = JSON.parse(args[1]);
} catch(e) {
    process.stderr.write("Invalid JSON: " + e.message + "\n");
    process.exit(1);
}

var searchPath = options.path || ".";
var query = options.query;
var limit = options.limit || 100000;
var ignoreCase = options.ignoreCase;
var wordRegexp = options.wordRegexp;
var literal = options.literal;
var hidden = options.hidden;
var pathInclude = options.pathInclude;
var isList = options.list;
var nakignore = options.pathToNakignore;

// Read .nakignore exclusions
var excludeDirs = [".git", ".svn", ".hg", ".c9", "node_modules"];
var excludeFiles = ["*.min.js"];
if (nakignore) {
    try {
        fs.readFileSync(nakignore, "utf8").split("\n").forEach(function(line) {
            line = line.trim();
            if (!line || line[0] === "#") return;
            if (line.indexOf("/") === -1 && line.indexOf("*") === -1)
                excludeDirs.push(line);
            else
                excludeFiles.push(line);
        });
    } catch(e) {}
}

// ---- FILE LISTING MODE ----
if (isList) {
    var findArgs = [searchPath, "-type", "f"];

    excludeDirs.forEach(function(d) {
        findArgs.push("-not", "-path", "*/" + d + "/*");
        findArgs.push("-not", "-path", "*/" + d);
    });
    excludeFiles.forEach(function(f) {
        findArgs.push("-not", "-name", f);
    });

    if (!hidden)
        findArgs.push("-not", "-name", ".*");

    if (pathInclude) {
        var includes = pathInclude.split(",").map(function(p) { return p.trim(); });
        // find doesn't easily do OR patterns without extra logic; just filter in node
    }

    var found = 0;
    var proc = childProcess.spawn("find", findArgs);
    proc.stdout.setEncoding("utf8");
    var buf = "";
    proc.stdout.on("data", function(d) {
        buf += d;
        var lines = buf.split("\n");
        buf = lines.pop();
        lines.forEach(function(line) {
            if (!line) return;
            if (found >= limit) return;
            if (pathInclude && includes.length) {
                var match = includes.some(function(pat) {
                    // simple glob: *.js -> ends with .js
                    if (pat[0] === "*") return line.endsWith(pat.slice(1));
                    return line.indexOf(pat) !== -1;
                });
                if (!match) return;
            }
            found++;
            process.stdout.write(line + "\n");
        });
    });
    proc.on("close", function() {
        if (buf) process.stdout.write(buf + "\n");
    });
    return;
}

// ---- SEARCH MODE ----
if (!query) {
    process.stderr.write("No query specified\n");
    process.exit(1);
}

// Build grep args
var grepArgs = ["-rn", "--include=*"];

if (ignoreCase) grepArgs.push("-i");
if (wordRegexp) grepArgs.push("-w");
if (literal) grepArgs.push("-F");
if (!hidden) grepArgs.push("--exclude=.*");

excludeDirs.forEach(function(d) { grepArgs.push("--exclude-dir=" + d); });
excludeFiles.forEach(function(f) { grepArgs.push("--exclude=" + f); });

if (pathInclude) {
    pathInclude.split(",").forEach(function(p) {
        grepArgs.push("--include=" + p.trim());
    });
}

grepArgs.push("--", query, searchPath);

var header = "Searching for '" + query + "' in " + searchPath + "\n";
process.stdout.write(header);

var grep = childProcess.spawn("grep", grepArgs);
grep.stdout.setEncoding("utf8");
grep.stderr.setEncoding("utf8");

var matchCount = 0;
var currentFile = null;
var outBuf = "";

grep.stdout.on("data", function(d) {
    if (matchCount >= limit) return;
    outBuf += d;
    var lines = outBuf.split("\n");
    outBuf = lines.pop();
    lines.forEach(function(line) {
        if (!line || matchCount >= limit) return;
        // grep -rn output: filepath:linenum:content
        var m = line.match(/^(.+?):(\d+):(.*)$/);
        if (!m) return;
        var file = m[1], lineNum = m[2], content = m[3];
        if (file !== currentFile) {
            currentFile = file;
            process.stdout.write(file + "\n");
        }
        process.stdout.write("  " + lineNum + ": " + content + "\n");
        matchCount++;
    });
});

grep.on("close", function() {
    process.stdout.write("\nFound " + matchCount + " matches\n");
});

#!/usr/bin/env node
// Runs nak (Find in Files, Go to File) without the folders no search needs:
// the kernel's (/proc, /sys), the devices (/dev) and runtime state (/run).
// Searches follow symlinks, so a link to / in the workspace searches the
// whole disk, and /proc alone has more files than the search limit.
// The folders are recognized by their filesystem, so also when reached
// through a link; one that is not a mount of its own (in some containers)
// is searched like any other folder.
"use strict";

var fs = require("fs");

var skip = Object.create(null);
var rootDev = fs.statSync("/").dev;
["/proc", "/sys", "/dev", "/run"].forEach(function(dir) {
    try {
        var dev = fs.statSync(dir).dev;
        if (dev !== rootDev)
            skip[dev] = true;
    } catch (e) {}
});

var readdir = fs.readdir;
fs.readdir = function(dir) {
    var args = arguments;
    var callback = args[args.length - 1];
    fs.stat(dir, function(err, stat) {
        if (!err && skip[stat.dev])
            return callback(null, []);
        readdir.apply(fs, args);
    });
};

require("nak/lib/nak").run();

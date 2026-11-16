#!/usr/bin/env node
/*global describe it */
"use strict";
"use server";

require("c9/inline-mocha")(module);

var assert = require("assert");
var workspace = require("./workspace");

describe(__filename, function() {
    describe("isInside", function() {
        it("recognizes a folder and what is under it", function() {
            assert.ok(workspace.isInside("/home/dev/ws", "/home/dev/ws"));
            assert.ok(workspace.isInside("/home/dev/ws/sub", "/home/dev/ws"));
            assert.ok(workspace.isInside("/home/dev/ws/a/b", "/home/dev/ws"));
            assert.ok(workspace.isInside("/home/dev/ws/sub", "/home/dev/ws/"));
        });
        it("rejects what is outside, including a prefix that is not a folder", function() {
            assert.ok(!workspace.isInside("/home/dev/ws2", "/home/dev/ws"));
            assert.ok(!workspace.isInside("/home/dev", "/home/dev/ws"));
            assert.ok(!workspace.isInside("/etc", "/home/dev/ws"));
            assert.ok(!workspace.isInside("/home/dev/wsfoo", "/home/dev/ws"));
            assert.ok(!workspace.isInside("", "/home/dev/ws"));
            assert.ok(!workspace.isInside("/x", ""));
        });
    });

    describe("resolveWorkspace", function() {
        var configured = "/home/dev/workspace";
        var home = "/home/dev";
        it("keeps the configured workspace when nothing or it is requested", function() {
            assert.equal(workspace.resolveWorkspace(null, configured, home), configured);
            assert.equal(workspace.resolveWorkspace(configured, configured, home), configured);
        });
        it("allows a folder inside the workspace or the home folder", function() {
            assert.equal(workspace.resolveWorkspace("/home/dev/workspace/app", configured, home), "/home/dev/workspace/app");
            assert.equal(workspace.resolveWorkspace("/home/dev/other", configured, home), "/home/dev/other");
            // a sibling of the workspace, still under home
            assert.equal(workspace.resolveWorkspace("/home/dev/workspace2", configured, home), "/home/dev/workspace2");
        });
        it("falls back to the configured workspace for a folder elsewhere", function() {
            assert.equal(workspace.resolveWorkspace("/etc", configured, home), configured);
            assert.equal(workspace.resolveWorkspace("/", configured, home), configured);
            assert.equal(workspace.resolveWorkspace("/home/dev2", configured, home), configured);
            assert.equal(workspace.resolveWorkspace("/srv/app", configured, home), configured);
        });
        it("works without a home folder", function() {
            assert.equal(workspace.resolveWorkspace("/home/dev/other", configured, null), configured);
            assert.equal(workspace.resolveWorkspace("/home/dev/workspace/app", configured, null), "/home/dev/workspace/app");
        });
    });

    describe("isTrusted", function() {
        var configured = "/home/dev/workspace";
        it("trusts the configured workspace", function() {
            assert.ok(workspace.isTrusted(configured, configured, []));
            assert.ok(workspace.isTrusted(configured, configured, null));
        });
        it("trusts a folder the user approved", function() {
            assert.ok(workspace.isTrusted("/home/dev/other", configured, ["/home/dev/other"]));
        });
        it("does not trust another folder", function() {
            assert.ok(!workspace.isTrusted("/home/dev/other", configured, []));
            assert.ok(!workspace.isTrusted("/home/dev/other", configured, ["/home/dev/else"]));
            assert.ok(!workspace.isTrusted("/home/dev/workspace/sub", configured, []));
        });
    });

    describe("trustedFolders", function() {
        it("reads the approved folders", function() {
            assert.deepEqual(workspace.trustedFolders(JSON.stringify(["/a", "/b"])), ["/a", "/b"]);
        });
        it("returns [] for a missing, empty or broken file", function() {
            assert.deepEqual(workspace.trustedFolders(""), []);
            assert.deepEqual(workspace.trustedFolders(undefined), []);
            assert.deepEqual(workspace.trustedFolders("["), []);
            assert.deepEqual(workspace.trustedFolders("{}"), []);
            assert.deepEqual(workspace.trustedFolders(JSON.stringify([1, "/a", null])), ["/a"]);
        });
    });
});

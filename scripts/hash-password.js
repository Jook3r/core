#!/usr/bin/env node
/**
 * hash-password.js — Generate a PBKDF2-SHA512 password hash for Cloud9 formauth.
 *
 * Usage:
 *   node scripts/hash-password.js
 *   node scripts/hash-password.js mypassword
 *
 * The output can be stored in a file and passed to the server via an environment
 * variable or config instead of the raw password.
 *
 * Note: when using -a user:pass at server startup the password is hashed
 * automatically in memory.  This script is for advanced use cases where you
 * want to pre-compute the hash (e.g. in CI, Docker images, or config files).
 */
"use strict";

var crypto = require("crypto");
var read   = require("read");

var ITERATIONS = 600000;
var KEY_LEN    = 64;
var DIGEST     = "sha512";

function hashPassword(password) {
    var salt    = crypto.randomBytes(32);
    var derived = crypto.pbkdf2Sync(password, salt, ITERATIONS, KEY_LEN, DIGEST);
    return ITERATIONS + ":" + salt.toString("hex") + ":" + derived.toString("hex");
}

if (process.argv[2]) {
    var result = hashPassword(process.argv[2]);
    console.log(result);
} else {
    read({ prompt: "Password:", silent: true, replace: "*" }, function(err, password) {
        if (err || !password) {
            console.error("No password provided.");
            process.exit(1);
        }
        read({ prompt: "Confirm password:", silent: true, replace: "*" }, function(err2, confirm) {
            if (err2) { console.error(err2.message); process.exit(1); }
            if (password !== confirm) {
                console.error("Passwords do not match.");
                process.exit(1);
            }
            console.log(hashPassword(password));
        });
    });
}

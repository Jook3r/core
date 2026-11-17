/**
 * Between the IDE and a debug adapter (Debug Adapter Protocol) that listens
 * on a TCP port, e.g. debugpy or Delve. Run on the server with node -e (see
 * getProxySource() in dap.js: comments and line breaks are taken out, so
 * every statement ends with a semicolon and no string has two slashes).
 *
 * The adapter's messages have a Content-Length header counted in bytes; the
 * IDE's socket carries text. So the IDE gets and sends one JSON message a
 * line, and the framing is done here.
 *
 * The connection to the adapter outlives the IDE's (a page that is loaded
 * again connects to this process again): the first line a new connection
 * gets says whether the debug session was started already.
 */
var net = require("net");
var host = "{DEBUGGED_PROCESS_HOST}";
var port = parseInt("{DEBUGGED_PROCESS_PORT}", 10);

var MAX_RETRIES = 100;
var RETRY_INTERVAL = 300;
var MAX_MESSAGE = 64 * 1024 * 1024;

var browser = null;
var adapter = null;
var toAdapter = [];
var toBrowser = [];
var started = false;
var ready = 0;

function frame(json) {
    return "Content-Length: " + Buffer.byteLength(json, "utf8") + "\r\n\r\n" + json;
}

function sendToAdapter(line) {
    if (/"command"\s*:\s*"initialize"/.test(line)) started = true;
    if (adapter) adapter.write(frame(line));
    else toAdapter.push(line);
}

function sendToBrowser(json) {
    if (browser) browser.write(json + "\n");
    else toBrowser.push(json);
}

var server = net.createServer(function(client) {
    if (browser) browser.destroy();
    browser = client;
    client.setEncoding("utf8");
    client.write(JSON.stringify({ type: "proxy", started: started }) + "\n");
    toBrowser.splice(0).forEach(function(json) { client.write(json + "\n"); });
    var text = "";
    client.on("data", function(data) {
        text += data;
        var lines = text.split("\n");
        text = lines.pop();
        lines.forEach(function(line) {
            line = line.trim();
            if (line.charAt(0) == "{") sendToAdapter(line);
        });
        if (text.length > MAX_MESSAGE) text = "";
    });
    client.on("error", function() {});
    client.on("close", function() {
        if (browser === client) browser = null;
    });
});
server.on("error", function() { process.exit(0); });
server.listen(port + 1, "127.0.0.1", function() { start(); });

function connect(retries) {
    var connection = net.connect(port, host);
    connection.once("connect", function() {
        connection.removeListener("error", onError);
        onAdapter(connection);
    });
    connection.on("error", onError);
    function onError(e) {
        if (e.code !== "ECONNREFUSED" || !retries) {
            console.error(retries ? String(e) : "Cannot connect to the debug adapter on port " + port);
            return process.exit(0);
        }
        setTimeout(function() { connect(retries - 1); }, RETRY_INTERVAL);
    }
}

function onAdapter(connection) {
    adapter = connection;
    var buffer = Buffer.alloc(0);
    connection.on("data", function(data) {
        buffer = buffer.length ? Buffer.concat([buffer, data]) : data;
        for (;;) {
            var end = buffer.indexOf("\r\n\r\n");
            if (end < 0) break;
            var length = /Content-Length:\s*(\d+)/i.exec(buffer.slice(0, end).toString("ascii"));
            if (!length) {
                buffer = buffer.slice(end + 4);
                continue;
            }
            length = parseInt(length[1], 10);
            if (length > MAX_MESSAGE) return process.exit(0);
            if (buffer.length < end + 4 + length) break;
            var json = buffer.slice(end + 4, end + 4 + length).toString("utf8");
            buffer = buffer.slice(end + 4 + length);
            sendToBrowser(json.replace(/[\r\n]+/g, " "));
        }
    });
    connection.on("error", function() { process.exit(0); });
    connection.on("close", function() {
        server.close();
        if (browser) browser.end();
        process.exit(0);
    });
    toAdapter.splice(0).forEach(function(line) { connection.write(frame(line)); });
    start();
}

function start() {
    if (++ready == 2) process.stdout.write("ß");
}

connect(MAX_RETRIES);

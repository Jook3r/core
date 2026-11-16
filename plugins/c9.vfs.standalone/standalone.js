"use strict";

plugin.consumes = [
    "connect.static", 
    "connect",
    "preview.handler",
    "connect.render",
    "connect.render.ejs"
];
plugin.provides = ["api", "passport"];

module.exports = plugin;
    
var fs = require("fs");
var assert = require("assert");
var async = require("async");
var join = require("path").join;
var extend = Object.assign;
var resolve = require("path").resolve;
var basename = require("path").basename;
var frontdoor = require("frontdoor");
var sandbox = require("./sandbox");
var workspace = require("./workspace");

function plugin(options, imports, register) {
    var previewHandler = imports["preview.handler"];
    var statics = imports["connect.static"];
    
    assert(options.workspaceDir, "Option 'workspaceDir' is required");
    assert(options.options, "Option 'options' is required");
    
    // Only the IDE's page is a document of the IDE's origin: what else a
    // browser may show (a file in the preview, an error page) is sandboxed.
    // The client-side tests (test mode: no login, a mock workspace) run in
    // a page of their own, which shows a test in a frame. Not for the
    // desktop version, whose window is not a browser's.
    var testing = options.options.testing;
    if (!options.local) {
        imports.connect.useStart(sandbox({
            pages: ["/ide.html"].concat(testing ? ["/static/test.html"] : []),
            framed: testing
        }));
    }
    
    // browsers attach the cached basic auth credentials to cross-site
    // requests and websockets, so only accept requests from our own origin
    // (behind a reverse proxy the public host is in X-Forwarded-Host)
    imports.connect.useStart(function(req, res, next) {
        // Without a login, only answer to localhost: a site that points its
        // own name at 127.0.0.1 (DNS rebinding) is the same origin as itself
        if (options.noLogin && !/^(localhost|127(\.\d+){3}|\[::1\])(:\d+)?$/.test(req.headers.host))
            return refuse("Host not allowed without a login");
        
        var origin = req.headers.origin;
        if (!origin) return next();
        
        var host = origin.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
        var forwardedHost = (req.headers["x-forwarded-host"] || "").split(",").pop().trim();
        if (host == req.headers.host || host == forwardedHost)
            return next();
        
        refuse("Cross-origin request refused");
        
        function refuse(message) {
            res.statusCode = 403;
            res.setHeader("Content-Type", "text/plain");
            res.end(message);
        }
    });
    

    // serve index.html
    statics.addStatics([{
        path: __dirname + "/www",
        mount: "/"
    }]);
    
    statics.addStatics([{
        path: __dirname + "/../../configs",
        mount: "/configs"
    }]);

    statics.addStatics([{
        path: __dirname + "/../../test/resources",
        mount: "/test"
    }]);

    var api = frontdoor();
    imports.connect.use(api);
    
    api.get("/", function(req, res, next) {
        res.writeHead(302, { "Location": options.sdk ? "/ide.html" : "/static/places.html" });
        res.end();
    });
    
    api.get("/ide.html", {
        params: {
            // the name of a config: it becomes part of the path of a file
            // that the server loads (getConfig)
            workspacetype: {
                type: /^[\w-]+$/,
                source: "query",
                optional: true
            },
            devel: {
                source: "query",
                optional: true
            },
            collab: {
                type: "number",
                optional: true,
                source: "query"
            },
            nocollab: {
                type: "number",
                optional: true,
                source: "query"
            },
            debug: {
                optional: true,
                source: "query"
            },
            packed: {
                source: "query",
                type: "number",
                optional: true
            }, 
            token: {
                source: "query",
                optional: true
            },  
            w: {
                source: "query",
                optional: true
            }, 
            config: {
                type: "number",
                source: "query",
                optional: true
            },
            settings: {
                type: "number",
                source: "query",
                optional: true
            },
        }
    }, function(req, res, next) {

        var configName = getConfigName(req.params, options);

        var collab = options.collab && req.params.collab !== 0 && req.params.nocollab != 1;
        var opts = extend({}, options);
        opts.options.collab = collab;
        if (req.params.packed == 1)
            opts.packed = opts.options.packed = true;
        
        var cdn = options.options.cdn;
        options.options.themePrefix = "/static/" + cdn.version + "/skin/" + configName;
        options.options.workerPrefix = "/static/" + cdn.version + "/worker";
        options.options.CORSWorkerPrefix = opts.packed ? "/static/" + cdn.version + "/worker" : "";
        
        api.updatConfig(opts.options, {
            w: req.params.w,
            token: req.params.token
        });
        
        opts.options.debug = req.params.debug !== undefined;
        var workspaceSettings = getSettings(configName, options);
        
        res.setHeader("Cache-Control", "no-cache, no-store");
        
        if (req.params.settings == 1)
            return res.json(workspaceSettings);
        
        if (req.params.config == 1)
            return res.json(getConfig(configName, workspaceSettings));
        
        res.render(__dirname + "/views/standalone.html.ejs", {
            architectConfig: getConfig(configName, workspaceSettings),
            configName: configName,
            packed: opts.packed,
            standalone: true,
            version: opts.version
        }, next);
    });
    
    api.get("/_ping", function(params, callback) {
        return callback(null, { "ping": "pong" }); 
    });
    
    api.get("/preview/:path*", [
        function(req, res, next) {
            req.projectSession = {
                pid: 1
            };
            req.session = {};
            api.authenticate()(req, res, next);
        },
        previewHandler.getProxyUrl(function() {
            var serverOptions = options.options;
            var host = serverOptions.host;
            if (host == "0.0.0.0") host = "localhost";
            return {
                url: (serverOptions.secure ? "https://" : "http://") + host + ":" + serverOptions.port + "/vfs"
            };
        }),
        previewHandler.proxyCall()
    ]);
    
    api.get("/preview", function(req, res, next) {
        res.redirect(req.url.replace(/^[^?]*/, "$&/"));
    });

    api.get("/vfs-root", function(req, res, next) {
        if (!options.options.testing)
            return next();
            
        res.writeHead(200, { "Content-Type": "application/javascript" });
        res.end("define(function(require, exports, module) { return " 
            + JSON.stringify(options.workspaceDir.replace(/\\/g, "/")) + "; });");
    });
    api.get("/vfs-home", function(req, res, next) {
        if (!options.options.testing)
            return next();
            
        res.writeHead(200, { "Content-Type": "application/javascript" });
        res.end("define(function(require, exports, module) { return " 
            + JSON.stringify(process.env.HOME.replace(/\\/g, "/")) + "; });");
    });

    api.get("/update", function(req, res, next) {
        res.writeHead(200, {
            "Content-Type": "application/javascript", 
            "Access-Control-Allow-Origin": "*"
        });
        var path = resolve(__dirname + "/../../build/output/latest.tar.gz");
        fs.readlink(path, function(err, target) {
            if (err) return next(err);
            
            res.end((target || "").split(".")[0]);
        });
    });
    
    api.get("/update/:path*", function(req, res, next) {
        var filename = req.params.path;
        var path = resolve(__dirname + "/../../build/output/" + resolve("/" + filename));
        
        var stream = fs.createReadStream(path);
        stream.on("error", function(err) {
            next(err);
        });
        stream.on("data", function(data) {
            if (!res.headersSent)
                res.writeHead(200, { "Content-Type": "application/octet-stream" });
                
            res.write(data);
        });
        stream.on("end", function(data) {
            res.end();
        });
    });

    api.get("/configs/require_config.js", function(req, res, next) {
        var config = res.getOptions().requirejsConfig || {};
        
        res.writeHead(200, { "Content-Type": "application/javascript" });
        res.end("requirejs.config(" + JSON.stringify(config) + ");");
    });
    
    api.get("/test/all.json", function(req, res, next) {
        var base = __dirname + "/../../";
        var blacklistfile = base + "/test/blacklist.txt";
        var filefinder = require(base + "/test/lib/filefinder.js");
        filefinder.find(base, "plugins", ".*_test.(js|ts)", blacklistfile, function(err, result) {
            result.all = result.list.concat(result.blacklist);
            async.filterSeries(result.list, function(path, next) {
                fs.readFile(base + path, "utf8", function(err, file) {
                    if (err) return next(false);
                    if (file.match(/^"use server"/m) && !file.match(/^"use client"/m))
                        return next(false);
                    next(file.match(/^define\(|^require\(\[/m) || /c9\.(ide|fs)/.test(path));
                });
            }, function(files) {
                result.list = files;
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify(result, null, 2));
            });
        });
    });
    
    // fake authentication
    api.authenticate = api.authenticate || function() {
        return function(req, res, next) { 
            req.user = extend({}, options.options.extendOptions.user);
            next(); 
        };
    };
    api.ensureAdmin = api.ensureAdmin || function() {
        return function(req, res, next) { 
            next(); 
        };
    };
    api.getVfsOptions = api.getVfsOptions || function(user, pid) {
        if (!options._projects) {
            options._projects = [options.workspaceDir];
        }
        // (a project's id is its place in the list, from 1)
        var wd = options._projects[pid - 1] || options._projects[0];
        
        return {
            workspaceDir: wd,
            extendOptions: {
                user: user,
                project: {
                    id: pid,
                    name: pid + "-" + wd
                },
                readonly: user.id > 100
            }
        };
    };    
    api.updatConfig = api.updatConfig || function(opts, params) {
        var id = params.token;
        opts.accessToken = id || "token";
        var user = opts.extendOptions.user;
        user.id = id || -1;
        user.name = id ? "user" + id : "johndoe";
        user.email = id ? "user" + id + "@c9.io" : "johndoe@example.org";
        user.fullname = id ? "User " + id : "John Doe";
        opts.workspaceDir = requestedWorkspace(params.w, options.workspaceDir);
        opts.projectName = basename(opts.workspaceDir);
        if (!options._projects) {
            options._projects = [options.workspaceDir];
        }
        var project = opts.extendOptions.project;
        var pid = options._projects.indexOf(opts.workspaceDir);
        if (pid == -1)
            pid = options._projects.push(opts.workspaceDir) - 1;
        // From 1: the client takes 0, the configured workspace's, for 1,
        // which was the first other folder's. Either then got the files of
        // the other, whichever was opened first.
        project.id = pid + 1;
    };
    
    imports.connect.setGlobalOption("apiBaseUrl", "");

    register(null, {
        "api": api,
        "passport": {
            authenticate: function() {
                return function(req, res, next) {
                    req.user = extend({}, options.options.extendOptions.user);
                    next();
                };
            }
        }
    });
}

function getConfigName(requested, options) {
    var name;
    if (requested && requested.workspacetype) {
        name = requested.workspacetype;
        if (name == "readonly" || name == "ro")
            name = "default-ro";
        else
            name = "workspace-" + name;
    }
    else if (options.workspaceType) {
        name = "workspace-" + options.workspaceType;
    }
    else if (options.options.client_config) {
        // pick up client config from settings, if present
        name = options.options.client_config;
    }
    else if (options.readonly) {
        name = "default-ro";
    }
    else {
        name = "default";
    }
    
    if (options.local)
        name += "-local";
    
    return name;
}

// The folder that ?w= asks for, if the browser may open it: the configured
// workspace, or a folder in it or in the home folder (see workspace.js).
// Anything else, or a folder that doesn't exist, is the configured workspace.
function requestedWorkspace(w, configured) {
    if (!w || typeof w != "string")
        return configured;
    
    var requestedReal, configuredReal, homeReal;
    try {
        requestedReal = fs.realpathSync(w);
        configuredReal = fs.realpathSync(configured);
    } catch (e) {
        return configured;
    }
    try {
        homeReal = process.env.HOME && fs.realpathSync(process.env.HOME);
    } catch (e) {}
    
    var folder = workspace.resolveWorkspace(requestedReal, configuredReal, homeReal);
    return folder == configuredReal ? configured : folder;
}

function getSettings(configName, options) {
    var installPath = options.settingDir || options.installPath || "";
    var workspaceDir = options.options.workspaceDir;
    var settings = {
        "user": join(installPath, "user.settings"),
        "project": join(options.local ? installPath : join(workspaceDir, ".c9"), "project.settings"),
        "state": join(options.local ? installPath : join(workspaceDir, ".c9"), "state.settings")
    };
    
    var fs = require("fs");
    for (var type in settings) {
        var data = "";
        try {
            data = fs.readFileSync(settings[type], "utf8");
        } catch (e) {
        }
        settings[type] = data;
    }
    
    // A folder's own project and state settings can run commands on the
    // server (a formatter, the linter's options, a restored Run tab): they
    // are for the configured workspace, and for a folder the user approved
    // (workspace.js). For another folder the IDE starts without them and
    // asks (plugins/c9.ide.configuration/configure.js).
    var trusted = true;
    var trustPath = workspaceDir;
    if (!options.local) {
        var configuredReal = options.workspaceDir;
        try {
            trustPath = fs.realpathSync(workspaceDir);
            configuredReal = fs.realpathSync(options.workspaceDir);
        } catch (e) {}
        trusted = workspace.isTrusted(trustPath, configuredReal,
            workspace.trustedFolders(settings.user));
        if (!trusted)
            settings.project = settings.state = "";
    }
    options.options.workspaceTrusted = trusted;
    options.options.workspaceTrustPath = trustPath;
    options.options.settings = settings;
    options.options.configName = configName;
    options.options.manifest = {
        version: options.options.manifest.version
    };
    return options.options;
}

function getConfig(configName, options) {    
    var filename = __dirname + "/../../configs/client-" + configName + ".js";
    return require(filename)(options);
}

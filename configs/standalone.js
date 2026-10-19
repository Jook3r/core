module.exports = function(config, optimist) {
    
    var path = require("path");
    
    if (!optimist.local) {
        optimist
            .boolean("t")
            .describe("t", "Start in test mode")
            .describe("k", "Kill tmux server in test mode")
            .default("b", false)
            .describe("b", "Start the bridge server - to receive commands from the cli")
            .default("w", config.workspaceDir)
            .describe("w", "Workspace directory")
            .alias("p", "port")
            .default("port", process.env.PORT || config.port)
            .describe("port", "Port")
            .alias("d", "debug")
            .default("debug", false)
            .describe("debug", "Turn debugging on")
            .alias("l", "listen")
            .default("listen", process.env.IP || config.host)
            .describe("listen", "IP address of the server")
            .boolean("help")
            .describe("workspacetype", "The workspace type to use")
            .alias("ws", "workspacetype")
            .describe("readonly", "Run in read only mode")
            .alias("ro", "readonly")
            .describe("packed", "Whether to use the packed version.")
            .boolean("packed")
            .default("packed", config.packed)
            .alias("a", "auth")
            .boolean("hosted")
            .describe("hosted", "Use default config of the hosted version")
            .default("hosted", false)
            .describe("auth", "Basic Auth username:password (or set C9_AUTH); use -a : to run without login on localhost")
            .describe("cache", "use cached version of cdn files")
            .default("cache", true)
            .describe("setting-path", "The path to store the settings.")
            .boolean("inProcessLocalFs")
            .describe("inProcessLocalFs", "Whether to run localfs in same process for debugging.")
            .default("inProcessLocalFs", config.inProcessLocalFs)
            .boolean("useBrowserCache")
            .describe("useBrowserCache", "Use window.caches api if available for faster loading, requires https://")
            .describe("secure", "path to file containing ssl certificate (can be generated using scripts/create-cert.sh)");
    }

    require("./utils/ssl")(config, optimist);

    var argv = optimist.argv;
    if (argv.help)
        return null;

    var testing = argv.t;
    var baseProc = path.normalize(testing
        ? __dirname + "/../plugins/c9.fs/mock"
        : argv.w || (__dirname + "/../"));

    // if (testing && !argv["setting-path"])
    //     argv["setting-path"] = "/tmp/.c9";

    if (baseProc != "/" && baseProc != "\\") // special case / for windows
        baseProc = path.resolve(baseProc);

    process.env.BASE_PROC = baseProc;

    var port = argv.p;
    var host = argv.l;
    var debug = argv.d;
    var readonly = argv.readonly;
    var startBridge = argv.b;
    
    config.port = port || argv.port;
    config.host = host || argv.listen;
    
    var workspaceType = argv.workspacetype || null;
    
    if (argv.hosted)
        config.client_config = "default-hosted";
    
    if (!argv.hosted)
        config.sourceDir = path.dirname(__dirname);
    
    config.workspaceDir = baseProc;
    config.settingDir = argv["setting-path"];
    config.projectName = path.basename(baseProc);
    config.testing = testing;
    config.debug = debug;
    
    if (!config.startBridge)
        config.startBridge = startBridge;
    
    if (testing && argv.k)
        require("child_process").exec("tmux -L cloud91.9 kill-server", function() {});

    // credentials come from -a user:password or C9_AUTH (keeps the password
    // out of `ps`); the password may contain ":"
    var authString = argv.auth != null ? argv.auth + "" : process.env.C9_AUTH;
    // don't pass the credentials on to terminals and runners
    delete process.env.C9_AUTH;
    var auth = ["", ""];
    if (authString) {
        var i = authString.indexOf(":");
        auth = i == -1 ? [authString, ""] : [authString.slice(0, i), authString.slice(i + 1)];
    }

    var isLocalhost = /^(localhost|127(\.\d+){3}|::1|\[::1\])$/.test(host);
    if (authString == ":") {
        if (!isLocalhost) {
            console.error("Refusing to listen on " + host + " without a login.");
            console.error("Use -a username:password (or C9_AUTH), or --listen 127.0.0.1.");
            process.exit(1);
        }
        console.log("Warning: running Cloud9 without a login. Anything that can reach");
        console.log(host + ":" + config.port + " (e.g. a reverse proxy on this machine) gets full access.\n");
    }
    else if (!auth[0] || !auth[1]) {
        if (!testing && !config.packaging) {
            console.error("Cloud9 needs a username and password: set C9_AUTH=username:password");
            console.error("or pass -a username:password. Use -a : to run without a login on localhost.");
            process.exit(1);
        }
        auth = ["", ""];
    }

    var plugins = [
        {
            packagePath: "connect-architect/connect",
            port: port,
            host: host,
            websocket: true,
            showRealIP: !config.mode,
            secure: config.secure,
        },
        {
            packagePath: "connect-architect/connect.basicauth",
            username: auth[0],
            password: auth[1]
        },
        {
            packagePath: "connect-architect/connect.static",
            prefix: "/static"
        },
        {
            packagePath: "./c9.error/error_handler",
            mode: config.mode,
            scope: "standalone",
            hostname: config.hostname
        },
        "connect-architect/connect.remote-address",
        "connect-architect/connect.render",
        "connect-architect/connect.render.ejs",
        {
            packagePath: "connect-architect/connect.redirect",
            trustedDomainsRe: /.*/,
        }, 
        "connect-architect/connect.cors",
        "./c9.connect.favicon/favicon",
        // "./c9.logger/stdout-logger",
        
        "./c9.core/ext",
        
        {
            packagePath: "./c9.ide.server/ide-statics",
            // allow everything in standalone mode
            blacklist: {
                "c9.ide.server": true,
                "c9.ide.test.selenium": true
            },
            whitelist: {
                "c9.core": true,
                "c9.fs": true,
                "c9.automate": true,
                "c9.login.client": true,
                "c9.vfs.client": true,
                "c9.cli.bridge": true,
                "c9.nodeapi": true,
                "saucelabs.preview": true,
                "salesforce.sync": true,
                "salesforce.language": true
            }
        },
        "./c9.preview/statics",
        "./c9.nodeapi/nodeapi",
        {
            packagePath: "./c9.vfs.standalone/standalone",
            sdk: config.sdk,
            local: config.local,
            packed: argv.packed,
            collab: config.collab,
            version: config.cdn.version,
            options: config,
            installPath: config.installPath,
            settingDir: config.settingDir,
            correctedInstallPath: config.correctedInstallPath,
            debug: debug,
            workspaceDir: baseProc,
            projectUrl: config.projectUrl,
            homeUrl: config.homeUrl,
            workspaceType: workspaceType,
            readonly: readonly
        },
        "./c9.vfs.server/vfs.server",
        "./c9.error/logger.raygun_noop",
        {
            packagePath: "./c9.preview/preview.handler",
            selfSignedSSL: config.secure
        },
        "./c9.vfs.server/cache",
        "./c9.vfs.server/download",
        "./c9.vfs.server/filelist",
        "./c9.vfs.server/fetchcache",
        "./c9.vfs.server/statics",
        "./c9.analytics/mock_analytics",
        "./c9.metrics/mock_metrics",
        {
            packagePath: "./c9.vfs.server/vfs.connect.standalone",
            workspaceDir: baseProc,
            readonly: readonly,
            extendDirectory: config.extendDirectory,
            extendOptions: config.extendOptions,
            installPath: config.installPath,
            settingDir: config.settingDir,
            collab: config.collab,
            nakBin: config.nakBin,
            nodeBin: config.nodeBin,
            tmuxBin: config.tmux,
            vfs: {
                defaultEnv: { CUSTOM: 43 },
                local: config.local,
                debug: debug,
                inProcess: argv.inProcessLocalFs
            }
        /* ### BEGIN #*/
        }, {
            packagePath: "./c9.static/cdn",
            useBrowserCache: argv.useBrowserCache,
            cacheFiles: argv.cache
        }, {
            packagePath: "./c9.static/build",
            version: config.cdn.version,
            cache: config.cdn.cacheDir,
            compress: config.cdn.compress,
            baseUrl: config.cdn.baseUrl,
            virtual: config.cdn.virtual,
            config: "standalone"
        /* ### END #*/
        }
    ];
    
    return plugins;
};

if (!module.parent) require("../server")([__filename].concat(process.argv.slice(2)));

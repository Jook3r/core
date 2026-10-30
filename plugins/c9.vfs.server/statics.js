/**
 * Additional static files for the the smith.io client plugin
 *
 * @copyright 2013, Ajax.org B.V.
 */

main.consumes = ["Plugin", "connect.static"];
main.provides = ["smithio.server"];

module.exports = main;

function main(options, imports, register) {
    var Plugin = imports.Plugin;
    var statics = imports["connect.static"];
    
    var dirname = require("path").dirname;
    
    /***** Initialization *****/
    
    var plugin = new Plugin("Ajax.org", main.consumes);
    
    var loaded = false;
    function load() {
        if (loaded || options.disableUnpackagedClient) return false;
        loaded = true;
        
        // the browser build of engine.io-client, without withCredentials;
        // the package itself would only bring code for Node.js
        statics.addStatics([{
            path: __dirname + "/engine.io",
            mount: "/engine.io",
            rjs: [{
                "name": "engine.io",
                "location": "engine.io",
                "main": "engine.io.js"
            }]
        }]);

        statics.addStatics([{
            path: dirname(require.resolve("kaefer/lib/client")),
            mount: "/kaefer",
            rjs: [{
                "name": "kaefer",
                "location": "kaefer",
                "main": "client.js"
            }]
        }]);
        
        statics.addStatics([{
            path: dirname(require.resolve("smith")),
            mount: "/smith",
            rjs: [{
                "name": "smith",
                "location": "smith",
                "main": "smith.js"
            }]
        }]);
        
        statics.addStatics([{
            path: dirname(require.resolve("vfs-socket/consumer")),
            mount: "/vfs-socket",
            rjs: [{
                "name": "vfs-socket",
                "location": "vfs-socket"
            }]
        }]);

        statics.addStatics([{
            path: dirname(require.resolve("msgpack-js-browser")),
            mount: "/msgpack-js",
            rjs: [{
                "name": "msgpack-js",
                "location": "msgpack-js",
                "main": "msgpack.js"
            }]
        }]);
    
        statics.addStatics([{
            path: dirname(require.resolve("architect-build/build_support/mini_require")),
            mount: "/"
        }]);

    }
    
    /***** Lifecycle *****/
    
    plugin.on("load", function() {
        load();
    });
    
    /***** Register and define API *****/
    
    plugin.freezePublicAPI({});
    
    register(null, {
        "smithio.server": plugin
    });
}
define(function(require, exports, module) {
    
module.exports = function(session, options) {
    session.introduction = require("text!./intro.html");
    
    if (options.platform == "win32") {
        session.install({
            "name": "Node.js", 
            "description": "binary dependencies: node@0.12, pty.js, sqlite3"
        }, [
            {
                "tar.gz": { 
                    "url": "https://github.com/cloud9ide/sdk-deps-win32/releases/download/v0.0.1/node.tar.gz",
                    "target": "~/.c9/"
                }
            }
        ]);
        session.install({
            "name": "Msys", 
            "description": "minimal version of msys"
        }, [
            {
                "tar.gz": { 
                    "url": "https://github.com/cloud9ide/sdk-deps-win32/releases/download/v0.0.1/msys.tar.gz",
                    "target": "~/.c9/"
                }
            }
        ]);
    }
    else {
        // node, node-pty and the npm modules come from scripts/install-sdk.sh;
        // only check the system packages the terminal and runners need
        session.install({
            "name": "System packages",
            "description": "tmux and python3"
        }, {
            "bash": require("text!./check-deps.sh")
        });
    }
    // Show the installation screen
    session.start();
};


});
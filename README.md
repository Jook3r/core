Cloud9 3.0 SDK for Plugin Development
======================================

This is the core repository for the Cloud9 v3 SDK. The SDK allows you to run a version of Cloud9 that allows you to develop plugins and create a custom IDE based on Cloud9.
 
#### Creating Plugins ####

Run Cloud9 as described below, then follow the tutorials on [writing
plugins](https://cloud9-sdk.readme.io/docs/getting-started-with-cloud9-plugins)
and [working on the core plugins](https://cloud9-sdk.readme.io/docs/contributing-to-cloud9),
and the rest of the [SDK documentation](https://cloud9-sdk.readme.io/docs).
c9.io and docs.c9.io are gone (they redirect to AWS), so the parts of the
tutorials that use them don't work.

#### Installation ####

This fork runs on Ubuntu 24.04/26.04 with Node.js 24 LTS (22 also works),
tmux 3.x and Python 3. Install the system packages, then the SDK:

    sudo apt-get install -y git tmux python3 python3-venv build-essential
    git clone https://github.com/Jook3r/core.git onlineIDE
    cd onlineIDE
    scripts/install-sdk.sh

To update the SDK to the latest version run:

    git pull
    scripts/install-sdk.sh

`npm install` deletes the modules that are vendored in `node_modules`;
`scripts/install-sdk.sh` checks them out again. If you run npm yourself, run
`git checkout HEAD -- node_modules` afterwards.

To run Cloud9 on a server behind Apache with HTTPS, see
[deploy/README.md](deploy/README.md).

#### Starting Cloud9 ####

Cloud9 needs a username and password, given with `-a` or the `C9_AUTH`
environment variable (which keeps the password out of `ps`):

    C9_AUTH=user:password node server.js -w ~/workspace --packed

An address that tries 10 different wrong passwords within 15 minutes is
refused for 15 minutes; wrong passwords and logins are written to the log.

The following options can be used:

    --settings       Settings file to use
    --help           Show command line options.
    -t               Start in test mode
    -k               Kill tmux server in test mode
    -b               Start the bridge server - to receive commands from the cli  [default: false]
    -w               Workspace directory
    --port           Port                                       [default: 8181]
    --debug          Turn debugging on
    --listen         IP address of the server                   [default: 127.0.0.1]
    --readonly       Run in read only mode
    --packed         Use the prebuilt client (built by scripts/install-sdk.sh, or scripts/makestandalone.sh --compress)
    --auth, -a       Basic Auth username:password; -a : runs without a login (localhost only)
    --no-cache       Don't use the cached version of CSS

Now visit [http://localhost:8181/ide.html](http://localhost:8181/ide.html) to load Cloud9.

Terminals and runners have the `c9` command on their PATH: `c9 open file`
opens a file in an editor tab (a file in the workspace or the home folder).
With Preferences > User Settings > Terminal > Use Cloud9 as the Default
Editor, `git commit` opens the message in a tab and waits until you close it.

Happy coding, Cloud9

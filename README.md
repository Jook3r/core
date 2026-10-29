Cloud9 3.0 SDK for Plugin Development
======================================

This is the core repository for the Cloud9 v3 SDK. The SDK allows you to run a version of Cloud9 that allows you to develop plugins and create a custom IDE based on Cloud9.
 
#### Creating Plugins ####

The best and easiest way to create plugins is on c9.io. Please check out this tutorial for how to [get started writing plugins.](http://cloud9-sdk.readme.io/v0.1/docs/getting-started-with-cloud9-plugins)

We also have a tutorial for how to get started working on the core plugins. [Check out that tutorial here.](http://cloud9-sdk.readme.io/v0.1/docs/contributing-to-cloud9)

#### Documentation ####

We have several documentation resources for you:

<table>
    <tr><th>SDK documentation</th><td>http://cloud9-sdk.readme.io/v0.1/docs</td></tr>
    <tr><th>API documentation</th><td>http://docs.c9.io/api</td></tr>
    <tr><th>User documentation</th><td>http://docs.c9.io</td></tr>
</table>

Please join the mailinglist to get support or give support to the growing community of plugin developers:
https://groups.google.com/forum/#!forum/cloud9-sdk

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

#### Running Tests ####

Run server side tests with:
    
    npm run test
    
Run client side tests with:

    npm run ctest
    
Then visit [http://localhost:8181/static/test](http://localhost:8181/static/test) in your browser.

Happy coding, Cloud9

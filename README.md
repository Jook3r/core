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

Follow these steps to install the SDK:

    git clone https://github.com/Jook3r/core.git onlineIDE
    cd onlineIDE
    scripts/install-sdk.sh
    sudo scripts/makestandalone.sh
    
To update the SDK to the latest version run:

    git pull origin master
    scripts/install-sdk.sh
    
Please note that if you are using npm version >=3 and run npm install manually, you need to run `git checkout HEAD -- node_modules` to restore the files deleted by npm.
Cloud9 is known to work with node versions 0.10 to 8, but Newer versions should work too.

#### Starting Cloud9 ####

Start the Cloud9 as follows:

    node server.js

The following options can be used:

    --settings       Settings file to use
    --help           Show command line options.
    -t               Start in test mode
    -k               Kill tmux server in test mode
    -b               Start the bridge server - to receive commands from the cli  [default: false]
    -w               Workspace directory
    --port           Port
    --debug          Turn debugging on
    --listen         IP address of the server
    --readonly       Run in read only mode
    --packed         Whether to use the packed version.
    --auth           Basic Auth username:password
    --collab         Whether to enable collab.
    --no-cache       Don't use the cached version of CSS

Now visit [http://localhost:8181/ide.html](http://localhost:8181/ide.html) to load Cloud9.

#### Running Tests ####

Run server side tests with:
    
    npm run test
    
Run client side tests with:

    npm run ctest
    
Then visit [http://localhost:8181/static/test](http://localhost:8181/static/test) in your browser.

Happy coding, Cloud9

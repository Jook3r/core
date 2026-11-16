#!/bin/bash -e
#
# Runs the tests. Needs the setup done (scripts/install-sdk.sh).
#
#   scripts/run-tests.sh           all three of these
#   scripts/run-tests.sh server    the server-side tests (*_test.js marked "use server",
#                                  and the Ace tests below)
#   scripts/run-tests.sh client    the client-side tests (the other *_test.js), each
#                                  in a browser (test/client.js)
#   scripts/run-tests.sh smoke     the smoke test (test/smoke.js), in a browser
#
# The packages the tests need go to test/node_modules, apart from Cloud9's
# own. The tests in a browser also need Chromium for Playwright, once:
#   npx --prefix test playwright install chromium
# (with --with-deps on a machine without the browser's system libraries)

cd "$(dirname "$0")/.."

red=$'\e[01;31m'
green=$'\e[01;32m'
resetColor=$'\e[0m'

# tests that need services this repo doesn't have: the hosted collab
# server (sqlite3) and the hosted API (c9.api)
SKIP="plugins/c9.ide.collab/server/collab-server_test.js plugins/c9.preview/preview_test.js"
# The tests of the editor, Ace (plugins/node_modules/ace). Not these: one
# that needs a package Ace's own repository has (plist), one that is a tool
# with arguments, one that expects to run without a DOM, and one of the
# module loader of Ace's worker, in whose place Cloud9 has its own
ACE_SKIP="plugins/node_modules/ace/tool/regexp_tokenizer_test.js
plugins/node_modules/ace/lib/ace/mode/_test/highlight_rules_test.js
plugins/node_modules/ace/lib/ace/ext/static_highlight_test.js
plugins/node_modules/ace/lib/ace/worker/worker_test.js"
ACE_TESTS=$(git ls-files 'plugins/node_modules/ace/**_test.js' | grep -vxF "$ACE_SKIP" | sort)

installTestPackages() {
    if [ ! -d test/node_modules ] || [ test/package.json -nt test/node_modules ]; then
        npm install --prefix test --no-package-lock --no-audit --no-fund --loglevel=error
        touch test/node_modules
    fi
}

# runTest <file> <command...>: runs a test file in a process of its own
# (serverTests counts them)
runTest() {
    local file=$1
    shift
    count=$((count + 1))
    if "$@" > /tmp/c9-test.log 2>&1; then
        echo "ok - $file"
    else
        echo "${red}not ok - $file${resetColor}"
        sed 's/^/    /' /tmp/c9-test.log | tail -30
        failed="$failed $file"
    fi
}

serverTests() {
    local failed= count=0 file
    for file in $(git ls-files '*_test.js' | grep -v node_modules/ | xargs grep -l '"use server"' | sort); do
        [[ " $SKIP " == *" $file "* ]] && continue
        # the mocha launcher script fails silently on newer Node.js, so run
        # _mocha itself
        runTest "$file" env NODE_PATH="$PWD/test/node_modules" \
            node test/node_modules/mocha/bin/_mocha -R dot -t 30000 "$file"
    done
    for file in $ACE_TESTS; do
        runTest "$file" node test/ace-test.js "$file"
    done
    rm -f /tmp/c9-test.log
    if [ "$failed" ]; then
        echo "${red}Server-side tests failed:$failed${resetColor}"
        return 1
    fi
    echo "${green}All $count server-side test files passed${resetColor}"
}

# browserTest <name> <script>
browserTest() {
    local major=$(node -p 'process.versions.node.split(".")[0]')
    if [ "$major" -lt 18 ]; then
        echo "Skipping the $1: Playwright needs Node.js 18 or newer"
        return 0
    fi
    node "$2"
}
clientTests() { browserTest "client-side tests" test/client.js; }
smokeTest() { browserTest "smoke test" test/smoke.js; }

installTestPackages
case "$1" in
    server) serverTests ;;
    client) clientTests ;;
    smoke) smokeTest ;;
    "") serverTests && clientTests && smokeTest ;;
    *) echo "Usage: $0 [server|client|smoke]" >&2; exit 1 ;;
esac

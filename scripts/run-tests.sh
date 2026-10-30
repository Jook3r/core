#!/bin/bash -e
#
# Runs the tests. Needs the setup done (scripts/install-sdk.sh).
#
#   scripts/run-tests.sh           the server-side tests, then the smoke test
#   scripts/run-tests.sh server    the server-side tests (*_test.js marked "use server")
#   scripts/run-tests.sh smoke     the smoke test (test/smoke.js), in a browser
#
# The packages the tests need go to test/node_modules, apart from Cloud9's
# own. The smoke test also needs Chromium for Playwright, once:
#   npx --prefix test playwright install chromium
# (with --with-deps on a machine without the browser's system libraries)

cd "$(dirname "$0")/.."

red=$'\e[01;31m'
green=$'\e[01;32m'
resetColor=$'\e[0m'

# tests that need services this repo doesn't have: the hosted collab
# server (sqlite3) and the hosted API (c9.api)
SKIP="plugins/c9.ide.collab/server/collab-server_test.js plugins/c9.preview/preview_test.js"

installTestPackages() {
    if [ ! -d test/node_modules ] || [ test/package.json -nt test/node_modules ]; then
        npm install --prefix test --no-package-lock --no-audit --no-fund --loglevel=error
        touch test/node_modules
    fi
}

serverTests() {
    local failed= count=0 file
    for file in $(git ls-files '*_test.js' | grep -v node_modules/ | xargs grep -l '"use server"' | sort); do
        [[ " $SKIP " == *" $file "* ]] && continue
        count=$((count + 1))
        # each in its own process; the mocha launcher script fails silently
        # on newer Node.js, so run _mocha itself
        if NODE_PATH="$PWD/test/node_modules" node test/node_modules/mocha/bin/_mocha -R dot -t 30000 "$file" \
            > /tmp/c9-test.log 2>&1; then
            echo "ok - $file"
        else
            echo "${red}not ok - $file${resetColor}"
            sed 's/^/    /' /tmp/c9-test.log | tail -30
            failed="$failed $file"
        fi
    done
    rm -f /tmp/c9-test.log
    if [ "$failed" ]; then
        echo "${red}Server-side tests failed:$failed${resetColor}"
        return 1
    fi
    echo "${green}All $count server-side test files passed${resetColor}"
}

smokeTest() {
    local major=$(node -p 'process.versions.node.split(".")[0]')
    if [ "$major" -lt 18 ]; then
        echo "Skipping the smoke test: Playwright needs Node.js 18 or newer"
        return 0
    fi
    node test/smoke.js
}

installTestPackages
case "$1" in
    server) serverTests ;;
    smoke) smokeTest ;;
    "") serverTests && smokeTest ;;
    *) echo "Usage: $0 [server|smoke]" >&2; exit 1 ;;
esac

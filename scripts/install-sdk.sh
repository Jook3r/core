#!/bin/bash -e
#
# Sets up a Cloud9 checkout to run with `node server.js`.
#
# Requirements (Ubuntu 24.04 / 26.04):
#   - Node.js 24 LTS (22 also works), from nodejs.org or NodeSource
#   - sudo apt-get install -y git tmux python3 build-essential
#     (build-essential and python3 are needed to compile node-pty)
#
# Run it again after pulling new changes.

set -e
has() {
  type "$1" > /dev/null 2>&1
}

cd "$(dirname "$0")/.."

red=$'\e[01;31m'
green=$'\e[01;32m'
yellow=$'\e[01;33m'
magenta=$'\e[01;35m'
resetColor=$'\e[0m'

checkDeps() {
    local missing=
    has git || missing="$missing git"
    has tmux || missing="$missing tmux"
    has python3 || missing="$missing python3"
    has make || missing="$missing build-essential"
    has g++ || [[ $missing == *build-essential* ]] || missing="$missing build-essential"
    if [ "$missing" ]; then
        echo "${red}Missing system packages:$missing${resetColor}" >&2
        echo "Install them with:" >&2
        echo "  sudo apt-get install -y$missing" >&2
        exit 1
    fi

    if ! has node || ! has npm; then
        echo "${red}Node.js is not installed.${resetColor} Install Node.js 24 LTS from https://nodejs.org" >&2
        exit 1
    fi
    local major=$(node -p 'process.versions.node.split(".")[0]')
    if [ "$major" -lt 22 ]; then
        echo "${red}Node.js $(node -v) is too old.${resetColor} Cloud9 needs Node.js 22 or newer (24 LTS recommended)." >&2
        exit 1
    fi
}

updateNodeModules() {
    echo "${magenta}--- Running npm install --------------------------------------------${resetColor}"
    npm install --omit=dev --no-audit --no-fund

    # npm deletes the modules that are vendored in git (they are not in
    # package.json), so check them out again
    if [ -e .git ]; then
        for i in $(git ls-tree --name-only HEAD node_modules/); do
            [ -d "$i" ] || git checkout HEAD -- "$i"
        done
    else
        echo "${yellow}Not a git checkout: can't restore the vendored modules in node_modules${resetColor}" >&2
        exit 1
    fi
    rm -f package-lock.json

    if ! node -e 'require("node-pty")' 2>/dev/null; then
        echo "${red}node-pty failed to build; the terminal won't work.${resetColor}" >&2
        echo "Make sure build-essential and python3 are installed and run this script again." >&2
        exit 1
    fi
    echo "${magenta}--------------------------------------------------------------------${resetColor}"
}

checkDeps

# cleanup build cache since c9.static doesn't do this automatically yet
rm -rf ./build/standalone

updateNodeModules

echo -e "nak\n.gitignore" >  node_modules/.gitignore

# prebuild the client for `server.js --packed` (fewer requests, less RAM);
# rerun after changing client code
echo "${magenta}--- Building the packed client ----------------------------------------${resetColor}"
./scripts/makestandalone.sh > /dev/null

echo "${green}Success!${resetColor} Start Cloud9 with:"
echo "  C9_AUTH=user:password node server.js -p 8181 -l 127.0.0.1 --packed -w ~/workspace"

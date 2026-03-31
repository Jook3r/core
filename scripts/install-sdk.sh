#!/bin/bash -e

set -e
has() {
  type "$1" > /dev/null 2>&1
  return $?
}

if has "curl"; then
  DOWNLOAD="curl -L "
elif has "wget"; then
  DOWNLOAD="wget -O - "
else
  echo "Error: you need curl or wget to proceed" >&2;
  exit 1
fi

cd "$(dirname "$0")/.."
SOURCE=$(pwd)

uname="$(uname -a)"
os=
arch="$(uname -m)"
case "$uname" in
    Linux\ *) os=linux ;;
    Darwin\ *) os=darwin ;;
    SunOS\ *) os=sunos ;;
    FreeBSD\ *) os=freebsd ;;
    CYGWIN*) os=windows ;;
    MINGW*) os=windows ;;
    MSYS_NT*) os=windows ;;
esac
case "$uname" in
    *x86_64*) arch=x64 ;;
    *i*86*) arch=x86 ;;
    *armv6l*) arch=arm-pi ;;
    *armv7l*) arch=arm-pi ;;
esac

red=$'\e[01;31m'
green=$'\e[01;32m'
yellow=$'\e[01;33m'
blue=$'\e[01;34m'
magenta=$'\e[01;35m'
resetColor=$'\e[0m'

# NO_PULL=
# NO_GLOBAL_INSTALL=
# FORCE=

updateNodeModules() {
    echo "${magenta}--- Running npm install --------------------------------------------${resetColor}"
    "$NPM" install --production
    
    for i in $(git show HEAD:node_modules/); do
        if [ "$i" != tree ] && [ "$i" != "HEAD:node_modules/" ]; then
            [ -d node_modules/$i ] || git checkout HEAD -- node_modules/$i;
        fi
    done
    rm -f package-lock.json
    
    echo "${magenta}--------------------------------------------------------------------${resetColor}"
}

updateCore() {
    if [ "$NO_PULL" ]; then
        return 0;
    fi

    # without this git merge fails on windows
    mv ./scripts/install-sdk.sh  './scripts/.#install-sdk-tmp.sh'
    rm -f ./scripts/.install-sdk-tmp.sh
    cp './scripts/.#install-sdk-tmp.sh' ./scripts/install-sdk.sh
    git checkout -- ./scripts/install-sdk.sh

    git remote add origin https://github.com/Jook3r/core 2> /dev/null || true
    git fetch origin
    git merge origin/master --ff-only || \
        echo "${yellow}Couldn't automatically update sdk core ${resetColor}"
}



installGlobalDeps() {
    if [[ -f ~/.c9/installed ]]; then
        return 0;
    fi

    echo "${magenta}--- Checking system dependencies -----------------------------------${resetColor}"

    if [[ $os == "linux" ]] || [[ $os == "darwin" ]]; then
        # Ensure python3 is available
        if ! has python3; then
            echo "${red}Error: python3 is required. Install it with: sudo apt install python3${resetColor}"
            exit 1
        fi

        # Ensure node is available
        if ! has node; then
            echo "${red}Error: node is required. Install it via nvm or your package manager.${resetColor}"
            exit 1
        fi

        # Ensure tmux is available
        if ! has tmux; then
            echo "${yellow}Warning: tmux not found. Terminal support may be limited.${resetColor}"
            echo "${yellow}Install with: sudo apt install tmux${resetColor}"
        fi
    fi

    mkdir -p ~/.c9
    touch ~/.c9/installed
    echo "${green}System dependencies OK.${resetColor}"
}

############################################################################
export C9_DIR="$HOME"/.c9
if ! [[ $(which npm) ]]; then
    if [[ $os == "windows" ]]; then
        export PATH="$C9_DIR:$C9_DIR/node_modules/.bin:$PATH"
    else
        export PATH="$C9_DIR/node/bin:$C9_DIR/node_modules/.bin:$PATH"
    fi
fi
NPM=npm
NODE=node

# cleanup build cache since c9.static doesn't do this automatically yet
rm -rf ./build/standalone

# pull the latest version
updateCore || true

installGlobalDeps
updateNodeModules

echo -e "c9.*\n.gitignore" >  plugins/.gitignore
echo -e "nak\n.gitignore" >  node_modules/.gitignore

echo "Success!"

echo "run '${yellow}node server.js -p 8080 -a :${resetColor}' to launch Cloud9"

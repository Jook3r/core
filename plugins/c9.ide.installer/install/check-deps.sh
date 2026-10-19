# Checks the system packages Cloud9 needs at runtime. Nothing is installed
# here: on Ubuntu/Debian run the apt-get command printed below (or
# scripts/install-sdk.sh, which also installs the npm dependencies).

has() {
  type "$1" > /dev/null 2>&1
}

MISSING=
has tmux || MISSING="$MISSING tmux"
has python3 || MISSING="$MISSING python3"

if [ "$MISSING" ]; then
  echo "Missing system packages:$MISSING"
  echo "Install them with:"
  echo "  sudo apt-get install -y$MISSING"
  exit 1
fi

echo "$(tmux -V), $(python3 --version)"

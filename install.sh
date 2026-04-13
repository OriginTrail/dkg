#!/bin/sh
set -e

DKG_HOME="${DKG_HOME:-$HOME/.dkg}"
REPO_URL="${DKG_REPO:-https://github.com/OriginTrail/dkg-v9.git}"
BRANCH="${DKG_BRANCH:-main}"
BIN_DIR="${BIN_DIR:-$HOME/.local/bin}"

red() { printf '\033[0;31m%s\033[0m\n' "$1"; }
green() { printf '\033[0;32m%s\033[0m\n' "$1"; }
info() { printf '  %s\n' "$1"; }

echo ""
echo "DKG V9 Node Installer"
echo "====================="
echo ""

# Check prerequisites
command -v node >/dev/null 2>&1 || { red "Error: node is not installed (>= 20 required)."; exit 1; }
NODE_MAJOR=$(node -e "process.stdout.write(String(process.versions.node.split('.')[0]))")
if [ "$NODE_MAJOR" -lt 20 ]; then
  red "Error: Node.js >= 20 required (found v$(node -v))."
  exit 1
fi
command -v pnpm >/dev/null 2>&1 || { red "Error: pnpm is not installed. Install with: npm install -g pnpm"; exit 1; }
command -v git >/dev/null 2>&1 || { red "Error: git is not installed."; exit 1; }

green "Prerequisites OK (node v$(node -v | tr -d v), pnpm $(pnpm -v), git $(git --version | awk '{print $3}'))"
echo ""

RELEASES_DIR="$DKG_HOME/releases"
SLOT_A="$RELEASES_DIR/a"
SLOT_B="$RELEASES_DIR/b"
SLOT_A_ENTRY="$SLOT_A/packages/cli/dist/cli.js"
SLOT_B_ENTRY="$SLOT_B/packages/cli/dist/cli.js"

slot_ready() {
  slot_path="$1"
  entry_path="$2"
  [ -d "$slot_path/.git" ] && [ -f "$entry_path" ]
}

stage_markitdown() {
  slot_path="$1"
  slot_name="$2"
  cli_dir="$slot_path/packages/cli"
  script_path="$cli_dir/scripts/bundle-markitdown-binaries.mjs"
  if [ ! -d "$cli_dir" ]; then
    return
  fi
  if [ ! -f "$script_path" ]; then
    info "Skipping MarkItDown staging in slot $slot_name (this checkout predates bundled MarkItDown support)."
    return
  fi
  info "Staging MarkItDown binary in slot $slot_name ..."
  (cd "$cli_dir" && node ./scripts/bundle-markitdown-binaries.mjs --build-current-platform --best-effort)
}

mkdir -p "$RELEASES_DIR"

if [ -L "$RELEASES_DIR/current" ] && slot_ready "$SLOT_A" "$SLOT_A_ENTRY" && slot_ready "$SLOT_B" "$SLOT_B_ENTRY"; then
  green "Blue-green slots already exist. Skipping clone."
  stage_markitdown "$SLOT_A" "a"
  stage_markitdown "$SLOT_B" "b"
else
  if [ -L "$RELEASES_DIR/current" ]; then
    info "Detected incomplete slots. Rebuilding missing/broken slots..."
  fi
  info "Creating $DKG_HOME ..."

  if slot_ready "$SLOT_A" "$SLOT_A_ENTRY"; then
    info "Slot a already exists and is ready."
  else
    rm -rf "$SLOT_A"
    info "Cloning into slot a ..."
    git clone --branch "$BRANCH" "$REPO_URL" "$SLOT_A"
    info "Installing dependencies in slot a ..."
    (cd "$SLOT_A" && pnpm install --frozen-lockfile)
    info "Building slot a ..."
    (cd "$SLOT_A" && pnpm build)
  fi
  stage_markitdown "$SLOT_A" "a"

  if slot_ready "$SLOT_B" "$SLOT_B_ENTRY"; then
    info "Slot b already exists and is ready."
  else
    rm -rf "$SLOT_B"
    info "Cloning slot b (shared objects with a) ..."
    git clone --reference "$SLOT_A" --dissociate --branch "$BRANCH" "$REPO_URL" "$SLOT_B"
    info "Installing dependencies in slot b ..."
    (cd "$SLOT_B" && pnpm install --frozen-lockfile)
    info "Building slot b ..."
    (cd "$SLOT_B" && pnpm build)
  fi
  stage_markitdown "$SLOT_B" "b"

  # Ensure current points to a known-good active slot.
  ln -sfn a "$RELEASES_DIR/current"
  echo "a" > "$RELEASES_DIR/active"

  green "Slots created: a (active), b (standby)"
fi

# Create dkg symlink in bin dir
mkdir -p "$BIN_DIR"
DKG_BIN="$BIN_DIR/dkg"
CLI_ENTRY="$RELEASES_DIR/current/packages/cli/dist/cli.js"

if [ -f "$CLI_ENTRY" ]; then
  cat > "$DKG_BIN" <<'WRAPPER'
#!/bin/sh
DKG_HOME="${DKG_HOME:-$HOME/.dkg}"
exec node "$DKG_HOME/releases/current/packages/cli/dist/cli.js" "$@"
WRAPPER
  chmod +x "$DKG_BIN"
  info "Created $DKG_BIN"
else
  info "Warning: $CLI_ENTRY not found. You may need to build first."
fi

echo ""
green "Installation complete!"
echo ""
echo "Next steps:"
echo "  1. Ensure $BIN_DIR is in your PATH"
echo "  2. Run: dkg init"
echo "  3. Run: dkg start"
echo ""

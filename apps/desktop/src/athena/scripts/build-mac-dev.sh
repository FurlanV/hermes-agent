#!/usr/bin/env bash
# Build the unsigned Athena dev app (macOS, --dir, no publish) and print its path.
#
#   build-mac-dev.sh            pack and print the .app path
#   build-mac-dev.sh --launch   pack, then start it through the Athena launcher
#
# --launch runs $ATHENA_DESKTOP_LAUNCHER (default:
# $ATHENA_REPO/client/installer/macos/dev/athena-desktop.sh), passing the .app
# path as its first argument and as ATHENA_DESKTOP_APP. The launcher sets
# HERMES_HOME and HERMES_DESKTOP_HERMES and execs the app binary.
#
# Needs Node >= 26 and pnpm 12 on PATH, and `pnpm install` done at the repo root.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
desktop="$(cd "$here/../../.." && pwd)"
repo="$(cd "$desktop/../.." && pwd)"

launch=0
for arg in "$@"; do
  case "$arg" in
    --launch) launch=1 ;;
    -h | --help)
      sed -n '2,12p' "${BASH_SOURCE[0]}"
      exit 0
      ;;
    *)
      echo "unknown argument: $arg" >&2
      exit 2
      ;;
  esac
done

node_major="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$node_major" -lt 26 ]; then
  echo "Node >= 26 is required (found $(node --version)); prepend its bin dir to PATH" >&2
  exit 1
fi

display="$(node -p "require('$desktop/src/athena/branding.json').display")"

# The package is named "hermes", so filter by path, not by name.
(
  cd "$repo"
  HERMES_DESKTOP_VARIANT=athena \
    CSC_IDENTITY_AUTO_DISCOVERY=false \
    pnpm --filter ./apps/desktop run pack
)

case "$(uname -m)" in
  arm64) out="$desktop/release/mac-arm64" ;;
  *) out="$desktop/release/mac" ;;
esac
app="$out/$display.app"
if [ ! -d "$app" ]; then
  echo "pack finished but $app is missing" >&2
  exit 1
fi
echo "$app"

if [ "$launch" -eq 1 ]; then
  launcher="${ATHENA_DESKTOP_LAUNCHER:-${ATHENA_REPO:+$ATHENA_REPO/client/installer/macos/dev/athena-desktop.sh}}"
  if [ -z "$launcher" ] || [ ! -x "$launcher" ]; then
    echo "--launch needs ATHENA_DESKTOP_LAUNCHER or ATHENA_REPO pointing at the Athena launcher" >&2
    exit 1
  fi
  # VS Code terminals export this; Electron then runs as plain Node and exits.
  unset ELECTRON_RUN_AS_NODE
  ATHENA_DESKTOP_APP="$app" exec "$launcher" "$app"
fi

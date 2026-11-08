#!/usr/bin/env bash
# Regenerate every Athena icon file from the SVG sources in src/athena/assets/source.
#
#   make-icons.sh           write the icons over the upstream paths
#   make-icons.sh --check   exit 1 if any written icon differs from a fresh render
#
# Sources: athena-mark.svg (light), athena-mark-dark.svg (dark), and
# sickkids-logo.svg, a byte copy of athena/shared/logo (sha256 pinned in
# branding.json as logoSha256). Outputs, replaced in place so packing picks
# them up by their existing paths (after-pack.mjs copies assets/icon.icns):
#   assets/icon.{icns,ico,png}, assets/icon-mac.png      light mark
#   assets/icon-dark.{icns,ico,png}                      dark mark
#   assets/icon.icon/Assets/{art-light,art-dark,mono}.png  Icon Composer layers
#   public/apple-touch-icon.png                          favicon / window icon
# The Icon Composer package keeps upstream icon.json; compiling it needs actool
# from Xcode 26. Without it electron-builder packs only icon.icns.
#
# Needs rsvg-convert, iconutil (macOS) and python3. Output is deterministic.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
athena="$(cd "$here/.." && pwd)"
desktop="$(cd "$athena/../.." && pwd)"
source_dir="$athena/assets/source"

check=0
case "${1:-}" in
  "") ;;
  --check) check=1 ;;
  *)
    echo "usage: $0 [--check]" >&2
    exit 2
    ;;
esac

for tool in rsvg-convert iconutil python3; do
  command -v "$tool" >/dev/null || {
    echo "make-icons: $tool not found" >&2
    exit 1
  }
done

want="$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["logoSha256"])' "$athena/branding.json")"
have="$(shasum -a 256 "$source_dir/sickkids-logo.svg" | cut -d' ' -f1)"
if [ "$want" != "$have" ]; then
  echo "make-icons: sickkids-logo.svg sha256 $have does not match branding.json logoSha256 $want" >&2
  exit 1
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
out="$work/out"
mkdir -p "$out/assets/icon.icon/Assets" "$out/public"
# rsvg-convert resolves <image href> next to the SVG, so render from a copy.
cp "$source_dir"/*.svg "$work/"

render() { # svg size png
  rsvg-convert --width "$2" --height "$2" --keep-aspect-ratio --output "$3" "$work/$1"
}

# Icon Composer layers: the wordmark alone on a transparent 1024 canvas; the
# package's icon.json supplies the white / dark fill behind it.
layer() { # name [fill]  (no fill keeps the logo colours)
  local filter=""
  if [ -n "$2" ]; then filter='filter="url(#f)"'; fi
  cat >"$work/$1.svg" <<SVG
<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs><filter id="f" x="0" y="0" width="1" height="1" color-interpolation-filters="sRGB">
    <feFlood flood-color="${2:-#000000}"/><feComposite in2="SourceAlpha" operator="in"/>
  </filter></defs>
  <image href="sickkids-logo.svg" x="112" y="383.38" width="800" height="257.24" $filter/>
</svg>
SVG
}
layer layer-light ""
layer layer-dark "#ffffff"
layer layer-mono "#333333"

ico() { # svg ico
  local pngs=()
  for size in 16 24 32 48 64 128 256; do
    render "$1" "$size" "$work/ico-$size.png"
    pngs+=("$work/ico-$size.png")
  done
  python3 -I - "$2" "${pngs[@]}" <<'PY'
import struct, sys
out, files = sys.argv[1], sys.argv[2:]
blobs = [open(f, 'rb').read() for f in files]
sizes = [struct.unpack('>II', b[16:24])[0] for b in blobs]
head = struct.pack('<HHH', 0, 1, len(blobs))
offset = 6 + 16 * len(blobs)
entries = b''
for size, blob in zip(sizes, blobs):
    dim = 0 if size >= 256 else size
    entries += struct.pack('<BBBBHHII', dim, dim, 0, 0, 1, 32, len(blob), offset)
    offset += len(blob)
open(out, 'wb').write(head + entries + b''.join(blobs))
PY
}

icns() { # svg icns
  local set="$work/$(basename "$2" .icns).iconset"
  mkdir -p "$set"
  for size in 16 32 128 256 512; do
    render "$1" "$size" "$set/icon_${size}x${size}.png"
    render "$1" "$((size * 2))" "$set/icon_${size}x${size}@2x.png"
  done
  iconutil --convert icns --output "$2" "$set"
}

render athena-mark.svg 1024 "$out/assets/icon.png"
render athena-mark.svg 1024 "$out/assets/icon-mac.png"
render athena-mark.svg 1024 "$out/public/apple-touch-icon.png"
ico athena-mark.svg "$out/assets/icon.ico"
icns athena-mark.svg "$out/assets/icon.icns"
render athena-mark-dark.svg 1024 "$out/assets/icon-dark.png"
ico athena-mark-dark.svg "$out/assets/icon-dark.ico"
icns athena-mark-dark.svg "$out/assets/icon-dark.icns"
render layer-light.svg 1024 "$out/assets/icon.icon/Assets/art-light.png"
render layer-dark.svg 1024 "$out/assets/icon.icon/Assets/art-dark.png"
render layer-mono.svg 1024 "$out/assets/icon.icon/Assets/mono.png"

status=0
while IFS= read -r file; do
  rel="${file#"$out"/}"
  if [ "$check" -eq 1 ]; then
    if ! cmp -s "$file" "$desktop/$rel"; then
      echo "stale: $rel" >&2
      status=1
    fi
  else
    cp "$file" "$desktop/$rel"
    echo "wrote $rel"
  fi
done < <(find "$out" -type f | LC_ALL=C sort)
exit "$status"

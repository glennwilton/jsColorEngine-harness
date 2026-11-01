#!/usr/bin/env bash
# Builds oracle/it8gen against the Little CMS source that lcms_c/fetch-lcms2.sh
# downloaded. Needs gcc and make, so on Windows run it inside WSL.
#
#   ./build.sh             # uses the newest lcms2-* folder in lcms_c/
#   ./build.sh 2.20        # a specific version
set -euo pipefail
cd "$(dirname "$0")"

if [ $# -ge 1 ]; then
    LCMS="../lcms_c/lcms2-$1"
else
    LCMS=$(ls -d ../lcms_c/lcms2-* | sort -V | tail -1)
fi
[ -d "$LCMS/src" ] || { echo "no Little CMS source at $LCMS, run lcms_c/fetch-lcms2.sh"; exit 1; }

echo "[oracle] building it8gen against $LCMS"
# Named for its version, so a pinned older build can sit beside the current one.
VERSION=$(basename "$LCMS" | sed 's/^lcms2-//')
gcc -O2 -I"$LCMS/include" -I"$LCMS/src" it8gen.c "$LCMS"/src/*.c -lm -lpthread -o "it8gen-$VERSION"
echo "[oracle] built oracle/it8gen-$VERSION"

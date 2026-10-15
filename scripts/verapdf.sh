#!/bin/sh
# Checks every PDF under a directory against PDF/UA-1 with veraPDF (NFR-12, ACC-49, GATE-03).
# The image is pinned by digest (veraPDF 1.30.3). Exits non-zero if any file fails.
set -eu
dir=$(cd "${1:?usage: scripts/verapdf.sh <dir>}" && pwd)
image=verapdf/cli@sha256:d565095c67a083e693aebf7d1a15784007370571053fc1aa5b502665b9a78f9c
files=$(cd "$dir" && find . -name '*.pdf' | sed 's|^\./|/data/|' | sort)
[ -n "$files" ] || { echo "no PDFs under $dir" >&2; exit 1; }
# shellcheck disable=SC2086
docker run --rm -v "$dir:/data:ro" "$image" --flavour ua1 --format text $files

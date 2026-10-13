#!/usr/bin/env bash
# Runs one k6 profile from the pinned k6 container against the stack (SCL-03).
#   tests/load/run.sh submissions [full|smoke]
#   tests/load/run.sh sms-sessions [full|smoke]
#   tests/load/run.sh help [full|smoke]
# BASE_URL (default https://localhost) names the gateway. Results land in tests/load/out/.
set -euo pipefail
script="${1:?script name: submissions, sms-sessions or help}"
profile="${2:-smoke}"
here="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$here/out"
docker run --rm --network host --user "$(id -u):$(id -g)" \
  -v "$here:/load:ro" -v "$here/out:/out" \
  -e BASE_URL="${BASE_URL:-https://localhost}" -e PROFILE="$profile" \
  -e TENANT="${TENANT:-county}" -e EVENT="${EVENT:-westwind}" \
  grafana/k6:1.0.0 run --summary-export "/out/${script}-${profile}.json" "/load/${script}.js"

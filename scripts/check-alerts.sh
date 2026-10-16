#!/bin/sh
# Checks the Prometheus scrape config and alert rules and runs their unit tests
# with promtool (NFR-10, ADR-0023). The image is pinned by digest (Prometheus
# 3.5.0). Exits non-zero if the config is invalid or a rule test fails.
set -eu
dir=$(cd "$(dirname "$0")/../infra/prometheus" && pwd)
image=prom/prometheus@sha256:63805ebb8d2b3920190daf1cb14a60871b16fd38bed42b857a3182bc621f4996
docker run --rm -v "$dir:/etc/prometheus:ro" --entrypoint promtool "$image" check config /etc/prometheus/prometheus.yml
docker run --rm -v "$dir:/etc/prometheus:ro" --entrypoint promtool "$image" test rules /etc/prometheus/alerts.test.yml

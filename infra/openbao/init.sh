#!/bin/sh
# One-shot: initialise (first run) and unseal (every start) the LOCAL OpenBao,
# enable the transit engine and issue a narrowly scoped app token.
# DEV ONLY: the unseal key and root token sit in the `keys-init` volume.
# Never use this outside a laptop; the cloud uses KMS (ADR-0009).
set -eu
export BAO_ADDR="${BAO_ADDR:-http://keys:8200}"
STATE=/bao-init
mkdir -p "$STATE"

until bao status -format=json >/dev/null 2>&1 || [ $? -eq 2 ]; do sleep 1; done

if ! bao status -format=json | grep -q '"initialized": true'; then
  bao operator init -key-shares=1 -key-threshold=1 -format=json > "$STATE/init.json"
  chmod 600 "$STATE/init.json"
fi

UNSEAL_KEY=$(sed -n 's/.*"unseal_keys_b64": \[ *"\([^"]*\)".*/\1/p' "$STATE/init.json" | head -1)
if [ -z "$UNSEAL_KEY" ]; then
  UNSEAL_KEY=$(tr -d '\n ' < "$STATE/init.json" | sed -n 's/.*"unseal_keys_b64":\["\([^"]*\)".*/\1/p')
fi
bao status -format=json | grep -q '"sealed": false' || bao operator unseal "$UNSEAL_KEY" >/dev/null

BAO_TOKEN=$(tr -d '\n ' < "$STATE/init.json" | sed -n 's/.*"root_token":"\([^"]*\)".*/\1/p')
export BAO_TOKEN

bao secrets list -format=json | grep -q '"transit/"' || bao secrets enable transit >/dev/null

# Least privilege for the application: only transit encrypt/decrypt/datakey on
# per-tenant keys, plus creating those keys (layer 1 creates one per tenant).
bao policy write cg-app - <<'POLICY' >/dev/null
path "transit/keys/tenant-*"          { capabilities = ["create", "read", "update"] }
path "transit/encrypt/tenant-*"       { capabilities = ["update"] }
path "transit/decrypt/tenant-*"       { capabilities = ["update"] }
path "transit/datakey/plaintext/tenant-*" { capabilities = ["update"] }
path "transit/rewrap/tenant-*"        { capabilities = ["update"] }
POLICY

if [ ! -s "$STATE/app-token" ]; then
  bao token create -policy=cg-app -period=768h -orphan -field=token > "$STATE/app-token"
fi
chmod 644 "$STATE/app-token"
echo '{"msg":"openbao ready","transit":true}'

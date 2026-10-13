# syntax=docker/dockerfile:1
FROM node:24-alpine AS build
WORKDIR /repo
COPY . .
# Optional extra CA for TLS-inspecting networks (see infra/node/Dockerfile).
RUN --mount=type=secret,id=extra_ca,required=false \
    if [ -s /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi \
 && corepack enable \
 && pnpm install --frozen-lockfile --filter "@cg/web-resident..." --filter "@cg/web-console..." --filter "@cg/web-help..." --filter "@cg/field..." \
 && pnpm --filter @cg/web-resident build \
 && pnpm --filter @cg/web-console build \
 && pnpm --filter @cg/web-help build \
 && pnpm --filter @cg/web-help check:size \
 && CI=1 EXPO_NO_TELEMETRY=1 pnpm --filter @cg/field build:web

FROM caddy:2.11.4-alpine
COPY infra/web/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /repo/apps/web-resident/dist /srv/resident
COPY --from=build /repo/apps/web-console/dist /srv/console
COPY --from=build /repo/apps/web-help/dist /srv/help
# The field app's web build (ADR-0014 / plan §5): the same screens the phone runs, for the browser tests.
COPY --from=build /repo/apps/field/dist /srv/field
USER 1000:1000
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --retries=5 CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1

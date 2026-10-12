# syntax=docker/dockerfile:1
# One image recipe for every Node service; APP selects the workspace package.
# Node 24 runs the TypeScript sources directly (type stripping), so there is no
# build step to drift from what was tested (ADR-0002).
FROM node:24-alpine AS deps
ARG APP
WORKDIR /repo
COPY . .
# Optional extra CA for networks that inspect TLS (county IT proxies):
#   docker build --secret id=extra_ca,src=/path/ca.pem ...  (no effect if absent)
RUN --mount=type=secret,id=extra_ca,required=false \
    if [ -s /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi \
 && corepack enable \
 && PKG=$(node -p "require('./${APP}/package.json').name") \
 && pnpm install --frozen-lockfile --prod --filter "${PKG}..."

FROM node:24-alpine
ARG APP
ENV NODE_ENV=production APP_DIR=/repo/${APP}
WORKDIR /repo
COPY --from=deps --chown=node:node /repo /repo
# Writable data directory for one-shot jobs (e.g. seed output volume).
RUN mkdir -p /data/seed && chown -R node:node /data
USER node
EXPOSE 8080
CMD ["sh", "-c", "exec node \"$APP_DIR/src/${ENTRY:-main.ts}\""]

# syntax=docker/dockerfile:1

ARG NODE_VERSION=22.23.4
FROM node:${NODE_VERSION}-bookworm-slim AS toolchain

ARG PNPM_VERSION=11.25.0
ENV PNPM_HOME=/pnpm
ENV PATH=${PNPM_HOME}:${PATH}
WORKDIR /workspace

# The optional build secret extends trust only during networked build steps.
# Ordinary builds do not need a proxy certificate or any environment-specific file.
RUN --mount=type=secret,id=proxy_ca,required=false \
    if [ -f /run/secrets/proxy_ca ]; then \
      export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; \
    fi; \
    npm install --global "pnpm@${PNPM_VERSION}"

FROM toolchain AS builder
COPY . .

RUN --mount=type=secret,id=proxy_ca,required=false \
    --mount=type=cache,id=memory-weave-pnpm,target=/pnpm/store \
    if [ -f /run/secrets/proxy_ca ]; then \
      export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; \
    fi; \
    pnpm install --frozen-lockfile --store-dir /pnpm/store

RUN pnpm build

# Build synchronizes injected workspace packages; deploy derives its own frozen lockfile.
RUN --mount=type=secret,id=proxy_ca,required=false \
    --mount=type=cache,id=memory-weave-pnpm,target=/pnpm/store \
    if [ -f /run/secrets/proxy_ca ]; then \
      export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; \
    fi; \
    pnpm_config_store_dir=/pnpm/store \
      pnpm --filter @memory-weave/server deploy --prod /out

FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
ENV DATA_DIR=/app/data
ENV WEB_DIST_DIR=/app/web
ENV ADMIN_DIST_DIR=/app/admin
WORKDIR /app

COPY --from=builder --chown=node:node /out/ ./
COPY --from=builder --chown=node:node /workspace/apps/web/dist/ ./web/
COPY --from=builder --chown=node:node /workspace/apps/admin/dist/ ./admin/
COPY --chown=node:node deploy/docker-entrypoint.mjs ./deploy/docker-entrypoint.mjs
RUN mkdir -p /app/data && chown node:node /app/data

USER node
EXPOSE 3000
CMD ["node", "deploy/docker-entrypoint.mjs"]

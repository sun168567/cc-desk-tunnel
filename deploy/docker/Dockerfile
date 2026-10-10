FROM ubuntu:24.04 AS base
# Build-time only: an ENV here would follow the image into the native CLI's environment.
ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl wget openssl openssh-client git rsync \
    bash tini tar xz-utils unzip zip jq ripgrep file less vim-tiny \
    python3 python3-pip python3-venv build-essential pkg-config \
    procps lsof iproute2 dnsutils netcat-openbsd sqlite3 \
    && rm -rf /var/lib/apt/lists/*
# Ubuntu's image already supplies uid 1000; use a dedicated unprivileged identity.
RUN userdel -r ubuntu && useradd --uid 1000 --create-home --shell /bin/bash ccdesktunnel

FROM base AS build
COPY scripts/install-linux.sh /tmp/install-linux.sh
USER ccdesktunnel
RUN CC_DESK_TUNNEL_RUNTIME=/home/ccdesktunnel/runtime bash /tmp/install-linux.sh
ENV PATH=/home/ccdesktunnel/runtime/node/bin:$PATH
WORKDIR /app
COPY --chown=ccdesktunnel:ccdesktunnel package.json package-lock.json ./
COPY --chown=ccdesktunnel:ccdesktunnel apps/server/package.json apps/server/package.json
COPY --chown=ccdesktunnel:ccdesktunnel apps/desktop/package.json apps/desktop/package.json
COPY --chown=ccdesktunnel:ccdesktunnel packages/protocol/package.json packages/protocol/package.json
RUN npm ci --omit=dev --workspace=@cc-desk-tunnel/server --workspace=@cc-desk-tunnel/protocol \
    && npm cache clean --force
COPY --chown=ccdesktunnel:ccdesktunnel apps/server/src apps/server/src
COPY --chown=ccdesktunnel:ccdesktunnel packages/protocol/src packages/protocol/src

FROM base
COPY --from=build --chown=root:root /home/ccdesktunnel/runtime /opt/runtime
COPY --from=build --chown=root:root /app /app
COPY deploy/docker/entrypoint.sh /usr/local/bin/proxy-entrypoint
COPY deploy/docker/healthcheck.mjs /app/healthcheck.mjs
# What a release needs from this image; a program installed from the client must not ask for more.
COPY deploy/docker/runtime-level /opt/runtime/level
RUN chmod 755 /usr/local/bin/proxy-entrypoint && mkdir /data && chown ccdesktunnel:ccdesktunnel /data
ENV PATH=/opt/runtime/node/bin:/opt/runtime/cli/bin:$PATH \
    HOME=/data/home
USER ccdesktunnel
WORKDIR /data/workspace
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD ["node", "--env-file=/data/config/service.env", "/app/healthcheck.mjs"]
ENTRYPOINT ["/usr/bin/tini", "-g", "--", "/usr/local/bin/proxy-entrypoint"]
CMD ["server"]

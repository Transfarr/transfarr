FROM rust:1.95-bookworm AS native
WORKDIR /build
COPY native/smb ./native/smb
RUN rustc --edition 2024 --test native/smb/vendor/smb-server/src/srvsvc.rs -o /tmp/srvsvc-tests && /tmp/srvsvc-tests
RUN cargo build --locked --release --manifest-path native/smb/Cargo.toml

FROM node:24-bookworm-slim AS frontend
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend ./
RUN npm run build

FROM node:24-bookworm-slim AS dependencies
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts
RUN npm rebuild sqlite3

FROM node:24-bookworm-slim
ARG TRANSFARR_VERSION=0.1.0
LABEL org.opencontainers.image.title="Transfarr" \
      org.opencontainers.image.version=$TRANSFARR_VERSION \
      org.opencontainers.image.source="https://github.com/transfarr/transfarr"
ENV NODE_ENV=production TRANSFARR_DATA_DIR=/data TRANSFARR_ROOT=/mnt
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=frontend /app/public ./public
COPY --from=native /build/native/smb/target/release/libtransfarr_smb.so ./native/smb/transfarr-smb.node
COPY lib ./lib
COPY server.mjs package.json ./
RUN apt-get update && apt-get install -y --no-install-recommends libcap2-bin \
    && setcap 'cap_net_bind_service=+ep' /usr/local/bin/node \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /data /mnt && chown 1000:1000 /data /mnt
USER 1000:1000
EXPOSE 3000 445 21 990 22 50000-50019
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.mjs"]

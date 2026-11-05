# syntax=docker/dockerfile:1
FROM golang:1.27.3-bookworm AS tui
WORKDIR /build
COPY tui/go.mod tui/go.sum ./
RUN go mod download
COPY tui/ ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /ash-tui .

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json ./
COPY src/ ./src/
COPY scripts/ ./scripts/
COPY frontend/ ./frontend/
COPY web/ ./web/
RUN npm run build:server && npm run build:web && npm prune --omit=dev --ignore-scripts

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production ASH_DATA_DIR=/var/lib/ash
WORKDIR /app
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules/
COPY --from=build /app/dist ./dist/
COPY --from=tui /ash-tui ./dist/ash-tui
COPY --chmod=0555 deploy/ash-entrypoint.sh /usr/local/bin/ash-entrypoint
RUN mkdir -p /var/lib/ash && chown node:node /var/lib/ash && chmod 700 /var/lib/ash \
    && chmod +x /app/dist/index.js && ln -s /app/dist/index.js /usr/local/bin/ash
USER node
EXPOSE 5050
VOLUME ["/var/lib/ash"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.ASH_SERVER_PORT||process.env.PORT||5050)+'/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/local/bin/ash-entrypoint"]
CMD ["node", "dist/server/main.js"]

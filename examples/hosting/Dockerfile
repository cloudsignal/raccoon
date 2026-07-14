# Deployable Raccoon hub (WebSocket + PWA + optional push).
# BUILD CONTEXT = the repo root:
#   docker build -f examples/hosting/Dockerfile -t raccoon-hub .
# (On Railway: set "Dockerfile path" to examples/hosting/Dockerfile and keep
#  the root directory at the repo root.)
FROM node:22-alpine
WORKDIR /app

COPY . .
RUN npm ci --no-audit --no-fund \
  && npm run build \
  && BUILD_ID="0.1.0-$(date -u +%Y%m%d%H%M)" npm run build:app

ENV HOST=0.0.0.0 \
    PORT=8790 \
    RACCOON_STORE_PATH=/data
VOLUME /data
EXPOSE 8790

CMD ["node", "examples/hosting/server.mjs"]

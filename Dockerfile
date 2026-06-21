# Node 24+ ships `node:sqlite` unflagged (it was experimental/flagged on 22.x),
# so the app's `node src/index.js` start command works without extra flags.
FROM node:24-alpine

WORKDIR /app

# Install production deps first so this layer caches across source changes.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Application code.
COPY src ./src
COPY public ./public

# SQLite cache lives here; mount a volume over it to persist across restarts.
RUN mkdir -p /app/data
ENV MDNS_DB_PATH=/app/data/mdns.db
ENV PORT=3000

# Informational only — under `--network host` (required for multicast) these are
# ignored, but they document the ports the app uses.
EXPOSE 3000/tcp
EXPOSE 5353/udp

CMD ["node", "src/index.js"]

# 2t1auth — production image
FROM node:20-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

# Install prod dependencies first (better layer caching).
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

# App source.
COPY . .

# SQLite data lives here (mount a volume to persist it).
RUN mkdir -p /app/data
ENV DB_PATH=/app/data/2t1auth.db
ENV HOST=0.0.0.0

EXPOSE 3000
CMD ["node", "src/index.js"]

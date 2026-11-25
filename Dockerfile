# Stage 1: Build client SPA, SSR bundle, and compiled Node server
FROM node:22-slim AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build && npm run build:server

# Stage 2: Minimal production runtime for Google Cloud Run
FROM node:22-slim AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/server.js ./server.js
COPY --from=builder /app/index.html ./index.html
COPY --from=builder /app/public ./public
COPY --from=builder /app/server/db/migration.sql ./server/db/migration.sql

RUN mkdir -p /app/data && chown -R node:node /app

USER node
EXPOSE 8080

CMD ["node", "server.js"]

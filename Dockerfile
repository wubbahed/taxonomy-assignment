# syntax=docker/dockerfile:1.7

FROM node:20-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json tsconfig.json ./

RUN --mount=type=cache,target=/root/.npm \
    npm ci

COPY src src
COPY drizzle drizzle
COPY openapi openapi

RUN npm run build && npm prune --omit=dev

FROM node:20-alpine AS runner
ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
COPY --from=builder /app/node_modules node_modules
COPY --from=builder /app/dist dist
COPY --from=builder /app/drizzle drizzle
COPY --from=builder /app/openapi openapi

EXPOSE 3000 9464
CMD ["node", "dist/index.js"]

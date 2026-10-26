# Build context is ./services so shared/ is reachable.
FROM node:20-alpine AS build
WORKDIR /app/ai-worker
COPY ai-worker/package.json ai-worker/package-lock.json ./
RUN npm ci
COPY ai-worker/ ./
COPY shared/ ../shared/
RUN npm run build

FROM node:20-alpine
WORKDIR /app/ai-worker
ENV NODE_ENV=production
COPY ai-worker/package.json ai-worker/package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/ai-worker/dist ./dist
USER node
CMD ["node", "dist/ai-worker/src/main.js"]

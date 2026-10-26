# Build context is ./services so shared/ is reachable.
FROM node:20-alpine AS build
WORKDIR /app/gc-worker
COPY gc-worker/package.json gc-worker/package-lock.json ./
RUN npm ci
COPY gc-worker/ ./
COPY shared/ ../shared/
RUN npm run build

FROM node:20-alpine
WORKDIR /app/gc-worker
ENV NODE_ENV=production
COPY gc-worker/package.json gc-worker/package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/gc-worker/dist ./dist
USER node
CMD ["node", "dist/gc-worker/src/main.js"]

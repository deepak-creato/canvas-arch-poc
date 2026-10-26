# Build context is ./services so shared/ is reachable.
FROM node:20-alpine AS build
WORKDIR /app/light-worker
COPY light-worker/package.json light-worker/package-lock.json ./
RUN npm ci
COPY light-worker/ ./
COPY shared/ ../shared/
RUN npm run build

FROM node:20-alpine
WORKDIR /app/light-worker
ENV NODE_ENV=production
COPY light-worker/package.json light-worker/package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/light-worker/dist ./dist
USER node
CMD ["node", "dist/light-worker/src/main.js"]

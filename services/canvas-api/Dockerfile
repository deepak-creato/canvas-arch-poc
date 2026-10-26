# Build context is ./services so shared/ is reachable.
FROM node:20-alpine AS build
WORKDIR /app/canvas-api
COPY canvas-api/package.json canvas-api/package-lock.json ./
RUN npm ci
COPY canvas-api/ ./
COPY shared/ ../shared/
RUN npm run build

FROM node:20-alpine
WORKDIR /app/canvas-api
ENV NODE_ENV=production
COPY canvas-api/package.json canvas-api/package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/canvas-api/dist ./dist
USER node
CMD ["node", "dist/canvas-api/src/main.js"]

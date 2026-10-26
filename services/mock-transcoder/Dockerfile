# Build context is ./services so shared/ is reachable.
FROM node:20-alpine AS build
WORKDIR /app/mock-transcoder
COPY mock-transcoder/package.json mock-transcoder/package-lock.json ./
RUN npm ci
COPY mock-transcoder/ ./
COPY shared/ ../shared/
RUN npm run build

FROM node:20-alpine
WORKDIR /app/mock-transcoder
ENV NODE_ENV=production
COPY mock-transcoder/package.json mock-transcoder/package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/mock-transcoder/dist ./dist
USER node
CMD ["node", "dist/mock-transcoder/src/main.js"]

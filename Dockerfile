# Multi-stage: build dist/ inside the image so `docker build` works from a fresh checkout (CI-friendly).
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY public ./public
ENV DB_PATH=/app/data/portal.db
VOLUME ["/app/data"]
EXPOSE 8787
CMD ["npm", "start"]

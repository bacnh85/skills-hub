FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY dist ./dist
COPY public ./public
ENV DB_PATH=/app/data/portal.db
VOLUME ["/app/data"]
EXPOSE 8787
CMD ["node", "dist/server.js"]

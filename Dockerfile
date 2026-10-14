FROM node:22-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build
COPY web ./web
RUN npm --prefix web ci && npm --prefix web run build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=build /app/web/dist ./web/dist
COPY db ./db
USER node
EXPOSE 3000
HEALTHCHECK CMD node -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# migrate is idempotent (CREATE ... IF NOT EXISTS), so running it on every boot is safe
CMD ["sh", "-c", "node dist/migrate.js && node dist/server.js"]

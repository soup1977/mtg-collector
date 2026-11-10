# MTG Collector: one container, SQLite database in /data, backups in /backups.

# --- Build the web UI ---
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY client ./client
RUN npm run build

# --- Runtime: server + built UI, production dependencies only ---
FROM node:24-slim
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3077 \
    MTG_DB=/data/mtg.sqlite \
    MTG_BACKUP_DIR=/backups
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server ./server
RUN chmod +x server/docker-entrypoint.sh
COPY --from=build /app/client/dist ./client/dist
# The entrypoint hands /data and /backups to PUID:PGID (Unraid default nobody:users = 99:100)
# and drops root before starting the app.
ENV PUID=99 PGID=100
RUN mkdir -p /data /backups
VOLUME ["/data", "/backups"]
EXPOSE 3077
HEALTHCHECK --interval=60s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["/app/server/docker-entrypoint.sh"]
CMD ["node", "--no-warnings", "server/index.js"]

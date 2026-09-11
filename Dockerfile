# WhatsApp agent + dashboard, one container.
#
#   docker build -t whatsapp-agent .
#   docker run -d --name agent -p 127.0.0.1:3001:3001 --env-file .env -v agent-data:/data whatsapp-agent
#
# Everything that must survive a redeploy lives in the /data volume (the
# SQLite database and its backups). APP_ENCRYPTION_KEY is NOT in there - keep
# it, backed up, somewhere else: without it the stored credentials are noise.

# --- build: compile the server and the dashboard -------------------------------
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY web/package.json web/package-lock.json web/
RUN npm --prefix web ci
COPY . .
RUN npm run build && npm run build:web

# --- run: production dependencies and the compiled output only -----------------
FROM node:24-slim
ENV NODE_ENV=production \
    PORT=3001 \
    DB_PATH=/data/agent.db
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=build /app/web/dist ./web/dist
# The image's own "node" user, never root; it owns only the data volume.
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]

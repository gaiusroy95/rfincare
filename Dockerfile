# Full backend deploy for Google Cloud Run (includes src/, not only dist/).
# Build from the backend/ folder:
#   docker build -t rfincare-api:full .
#   gcloud run deploy rfincare-api --source .   (or push the image)

FROM node:20-alpine

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080
ENV SERVE_STATIC=false
ENV UPLOAD_DIR=/app/uploads

# Install production dependencies first (better layer cache)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy full backend application files
COPY src ./src
COPY scripts ./scripts
COPY migrations ./migrations
COPY data ./data
COPY assets ./assets

RUN mkdir -p /app/uploads /app/data \
  && addgroup -S rfincare \
  && adduser -S rfincare -G rfincare \
  && chown -R rfincare:rfincare /app

USER rfincare

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Run full source (not compiled dist/)
CMD ["node", "src/server.js"]

FROM oven/bun:1-alpine

RUN addgroup -S appgroup && adduser -S appuser -G appgroup

WORKDIR /app

COPY package.json ./
COPY src/ ./src/
COPY public/ ./public/

RUN chown -R appuser:appgroup /app

USER appuser

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD bun -e "process.exit((await fetch('http://localhost:3000/health')).ok ? 0 : 1)"

CMD ["bun", "run", "src/index.ts"]

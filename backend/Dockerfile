FROM node:20-alpine AS base

# Install curl for container health check
RUN apk add --no-cache curl

WORKDIR /app

# Copy package descriptors and install production dependencies
COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force

# Copy application source code
COPY src/ ./src/

# Run as non-root user for security
USER node

# Expose default port
ENV PORT=3000
ENV APP_ENV=production
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:${PORT}/v1/health || exit 1

# Start the server
CMD ["node", "src/server.js"]

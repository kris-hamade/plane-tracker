FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy application files
COPY notifier.mjs ./

# Expose API port
EXPOSE 3000

# Run the application
CMD ["node", "notifier.mjs"]


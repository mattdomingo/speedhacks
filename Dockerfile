FROM node:22.15.0-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY backend ./backend
COPY contracts ./contracts
COPY scripts/migrate.mjs ./scripts/migrate.mjs
USER node
ENV PORT=3000
EXPOSE 3000
CMD ["node", "backend/index.mjs"]

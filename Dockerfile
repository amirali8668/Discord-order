FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files and install ALL deps (including dev for build)
COPY package.json package-lock.json* ./
RUN npm install

# Copy source and build
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ─── Production image ──────────────────────────────────────────────────────────
FROM node:20-alpine AS production

WORKDIR /app

# Only copy production deps
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# Copy compiled output
COPY --from=builder /app/dist ./dist

# Railway injects PORT at runtime
ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["node", "dist/index.js"]

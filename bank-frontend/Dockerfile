# FinSecure Banking Portal (Next.js) — port 3001
# The browser calls the bank API (:8001) and Awaaz (:8000) directly, so those
# ports must be published on the host (see docker-compose.yml).

FROM node:20-alpine

# Recommended by Next.js for alpine (glibc shims used by some native modules)
RUN apk add --no-cache libc6-compat

WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

RUN npm run build \
 && npm prune --omit=dev \
 && chown -R node:node /app

# `next start` (npm start) listens on $PORT
ENV NODE_ENV=production \
    PORT=3001
USER node

EXPOSE 3001
CMD ["npm", "start"]

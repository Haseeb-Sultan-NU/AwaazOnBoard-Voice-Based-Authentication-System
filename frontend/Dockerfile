# Awaaz Enterprise Admin Portal (Next.js) — port 3000
# `/api/*` is proxied server-side to the Awaaz backend (see next.config.ts).

FROM node:20-alpine

# Recommended by Next.js for alpine (glibc shims used by some native modules)
RUN apk add --no-cache libc6-compat

WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# Proxy target is provided at build time AND runtime, so the rewrite is correct
# whether Next resolves it during `next build` or at server start.
ARG AWAAZ_API_INTERNAL_URL=http://awaaz-backend:8000
ENV AWAAZ_API_INTERNAL_URL=${AWAAZ_API_INTERNAL_URL}

RUN npm run build \
 && npm prune --omit=dev \
 && chown -R node:node /app

ENV NODE_ENV=production \
    PORT=3000
USER node

EXPOSE 3000
CMD ["npm", "start"]

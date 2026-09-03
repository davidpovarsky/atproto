FROM node:24.18-alpine3.23

RUN npm install -g pnpm@11.11.0

WORKDIR /app
COPY . .

ENV PUPPETEER_SKIP_DOWNLOAD=true
RUN pnpm install --no-frozen-lockfile
RUN pnpm run --recursive --stream --workspace-concurrency 1 --filter 'torah-appview-service...' build -- --force

WORKDIR /app/services/torah-appview
ENV NODE_ENV=production
EXPOSE 2584
CMD ["node", "--enable-source-maps", "index.ts"]

# Build context: repository root.  docker build -f apps/api/Dockerfile .
# Base images come from AWS's public mirror of the official Docker images (no Docker Hub rate limits).

FROM public.ecr.aws/docker/library/node:22-bookworm-slim AS build
WORKDIR /repo
RUN corepack enable
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json tsconfig.base.json ./
COPY packages ./packages
COPY apps/api ./apps/api
RUN pnpm install --frozen-lockfile --filter "@project/api..."
RUN pnpm --filter "@project/api..." build
# Self-contained production install of the API and its workspace packages only.
RUN pnpm --filter @project/api deploy --prod --legacy /out

FROM public.ecr.aws/docker/library/node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
# Amazon RDS certificate bundle, so TLS to the database is verified, not just encrypted.
ADD --chmod=0444 https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /etc/rds/global-bundle.pem
COPY --from=build --chown=node:node /out /app
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]

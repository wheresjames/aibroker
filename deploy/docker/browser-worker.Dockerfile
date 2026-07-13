FROM mcr.microsoft.com/playwright:v1.61.1-noble
WORKDIR /app
COPY package.json pnpm-workspace.yaml tsconfig.base.json pnpm-lock.yaml ./
COPY apps ./apps
COPY packages ./packages
RUN corepack enable && pnpm install --frozen-lockfile
USER pwuser
EXPOSE 8090
CMD ["./node_modules/.bin/tsx", "apps/browser-worker/src/index.ts"]

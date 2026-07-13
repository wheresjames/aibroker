FROM node:22-alpine
WORKDIR /app
COPY package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts
RUN corepack enable && pnpm install --frozen-lockfile=false
CMD ["pnpm", "--filter", "@aibroker/worker", "dev"]

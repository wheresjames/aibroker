FROM node:22-alpine
WORKDIR /app
RUN apk add --no-cache postgresql-client gzip age
COPY package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts
RUN corepack enable && pnpm install --frozen-lockfile=false
EXPOSE 8080
CMD ["pnpm", "--filter", "@aibroker/api", "dev"]

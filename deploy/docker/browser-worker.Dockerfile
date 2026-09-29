FROM mcr.microsoft.com/playwright:v1.61.1-noble
WORKDIR /app
COPY package.json pnpm-workspace.yaml tsconfig.base.json pnpm-lock.yaml ./
COPY apps ./apps
COPY packages ./packages
RUN corepack enable && pnpm install --frozen-lockfile
USER pwuser
EXPOSE 8090
# Login captures run headed under Xvfb (xvfb-run ships with the Playwright image).
ENV AIBROKER_BROWSER_CAPTURE_HEADLESS=false
CMD ["xvfb-run", "-a", "./node_modules/.bin/tsx", "apps/browser-worker/src/index.ts"]

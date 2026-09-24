# syntax=docker/dockerfile:1

# Multi-stage build. The final image carries production dependencies and the
# compiled output only: no sources, no toolchain, no dev dependencies.

FROM node:22-alpine AS base
WORKDIR /app
# tini is PID 1 so SIGTERM reaches node instead of being swallowed by the shell.
# Without it the Kafka consumer (cycle 7) would never get to shut down cleanly.
RUN apk add --no-cache tini


FROM base AS build
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
RUN npm run build


FROM base AS prod-deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force


FROM base AS runtime
ENV NODE_ENV=production

COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
# The MikroORM CLI reads the "mikro-orm" block of package.json to find the
# compiled config, which is how the migrate container runs migrations.
COPY --chown=node:node package.json ./

USER node
EXPOSE 3000

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/main.js"]

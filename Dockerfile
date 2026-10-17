# syntax=docker/dockerfile:1
ARG NODE_VERSION=24

# The app bundle is plain JavaScript, so build it on the build machine's own platform (no QEMU).
FROM --platform=$BUILDPLATFORM node:${NODE_VERSION}-slim AS build
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN npm install -g "$(node -p "require('./package.json').packageManager")" \
	&& pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

# Runtime dependencies for the target platform (resvg and better-sqlite3 ship prebuilt binaries).
FROM node:${NODE_VERSION}-slim AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN npm install -g "$(node -p "require('./package.json').packageManager")" \
	&& pnpm install --frozen-lockfile --prod --ignore-scripts

FROM node:${NODE_VERSION}-slim
# A font for the coordinates on rendered board images.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends fonts-dejavu-core \
	&& rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production \
	HOST=0.0.0.0 \
	PORT=5199 \
	CHESS_DATA_DIR=/data
COPY package.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/build ./build
COPY docker/entrypoint.sh /usr/local/bin/chess-entrypoint
VOLUME /data
EXPOSE 5199
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
	CMD node -e "fetch('http://127.0.0.1:' + process.env.PORT + '/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
ENTRYPOINT ["chess-entrypoint"]
CMD ["node", "build"]

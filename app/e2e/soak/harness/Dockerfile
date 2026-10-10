# syntax=docker/dockerfile:1
# The soak image: devctl compiled from this checkout inside the pinned Bun
# image, as .github/scripts/compile-binaries.sh compiles a release binary
# (workers embedded as extra entrypoints), plus the soak drivers. Build
# context is app/; Dockerfile.dockerignore keeps host node_modules out.
FROM oven/bun:1.4.2 AS build
WORKDIR /build
COPY package.json bun.lock bunfig.toml tsconfig.json ./
RUN bun install --frozen-lockfile
COPY src ./src
ARG DEVCTL_VERSION=0.0.0-soak
RUN bun build --compile --entry-naming "[name].[ext]" \
      --define "process.env.DEVCTL_VERSION=\"${DEVCTL_VERSION}\"" \
      --define 'process.env.OPENTUI_LIBC="glibc"' \
      --outfile /out/devctl \
      src/bin.ts src/adapters/storage/log-worker.ts src/adapters/daemon/event-loop-watchdog-worker.ts

FROM oven/bun:1.4.2
COPY --from=build /out/devctl /usr/local/bin/devctl
# The drivers import the image's own source (the spool format, for one), so
# both keep their app/ layout under /soak/app.
COPY --from=build /build/src /soak/app/src
COPY e2e/soak/harness/driver /soak/app/e2e/soak/harness/driver
RUN ln -s /soak/app/e2e/soak/harness/driver /soak/driver \
 && mkdir -p /soak/nofifo /work \
 && printf '#!/bin/sh\n# Forces the pipe path: FIFO setup fails and the service gets pipes.\nexit 1\n' > /soak/nofifo/mkfifo \
 && chmod 755 /soak/nofifo/mkfifo
ENV DEVCTL_HOME=/work/home NO_COLOR=1
WORKDIR /work

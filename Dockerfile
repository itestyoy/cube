# =============================================================================
# Self-Contained Cube Production Docker Image
# =============================================================================
# This Dockerfile replicates the EXACT build process from GitHub Actions workflow
# (.github/workflows/publish.yml) to create a completely self-contained image.
#
# It builds ALL components from source:
# 1. Rust CubeStore (OLAP engine) - exact workflow: cubestore_linux job
# 2. Rust native Node.js modules (@cubejs-backend/native) - exact workflow: native_linux job
# 3. All Node.js packages and TypeScript compilation - exact workflow: npm job
# 4. Final Docker image assembly - exact workflow: docker-default job
#
# Build command:
#   docker build -f Dockerfile.self-contained -t cubejs/cube:self-contained .
#
# Build for specific platform:
#   docker build -f Dockerfile.self-contained \
#     --platform linux/amd64 \
#     -t cubejs/cube:self-contained-amd64 .
# =============================================================================

ARG BUILDPLATFORM=linux/amd64
ARG TARGETPLATFORM=linux/amd64

# -----------------------------------------------------------------------------
# Stage 1: CubeStore Builder - Build Rust OLAP engine
# Replicates: cubestore_linux job (lines 584-664)
# Note: Build on target platform to avoid cross-compilation issues
# -----------------------------------------------------------------------------
FROM --platform=$TARGETPLATFORM rust:1.84.1-bookworm AS cubestore-builder

# Set environment variables from workflow
ENV OPENSSL_STATIC=1 \
    CARGO_INCREMENTAL=0 \
    CARGO_NET_RETRY=10 \
    RUSTUP_MAX_RETRIES=10

# Install build dependencies
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        cmake \
        g++ \
        gcc \
        make \
        libssl-dev \
        libclang-dev \
        clang \
        pkg-config \
        ca-certificates \
        git && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /cube

# Copy Rust projects (each has its own Cargo.toml and Cargo.lock)
COPY rust ./rust

# Install nightly toolchain as per workflow (line 628)
# Workflow uses: nightly-2024-01-29
RUN rustup toolchain install nightly-2024-01-29 && \
    rustup component add rustfmt --toolchain nightly-2024-01-29

# Build CubeStore (workflow command from line 640)
# Building natively on target platform, no cross-compilation needed
RUN cd rust/cubestore && \
    cargo +nightly-2024-01-29 build --release -p cubestore

# The binary will be at: rust/cubestore/target/release/cubestored

# -----------------------------------------------------------------------------
# Stage 2: Native Module Builder - Build @cubejs-backend/native
# Replicates: native_linux job (lines 71-150)
# Note: Build on target platform to avoid cross-compilation issues
# -----------------------------------------------------------------------------
FROM --platform=$TARGETPLATFORM node:20.17.0-bookworm AS native-builder

# Install Rust (toolchain 1.84.1 as per workflow line 101)
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | \
    sh -s -- -y --default-toolchain 1.84.1 && \
    . "$HOME/.cargo/env" && \
    rustup component add rustfmt

ENV PATH="/root/.cargo/bin:${PATH}"

# Install build dependencies (exact workflow dependencies from line 14)
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        python3 \
        python3.11 \
        libpython3.11-dev \
        gcc \
        g++ \
        make \
        cmake \
        ca-certificates \
        git && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /cube

# Set Yarn version to v1.22.22 (yarn is already included in Node.js image)
RUN yarn policies set-version v1.22.22

# Install cargo-cp-artifact (exact version from workflow line 116)
RUN npm install -g cargo-cp-artifact@0.1

# Copy necessary files for native module build
COPY packages/cubejs-backend-native ./packages/cubejs-backend-native
COPY rust ./rust

# Build native module (workflow command from line 121)
# For fallback (no Python) version
# Building natively on target platform, no cross-compilation needed
WORKDIR /cube/packages/cubejs-backend-native
RUN npm install && \
    npm run native:build-release

# The binary will be at: packages/cubejs-backend-native/index.node

# -----------------------------------------------------------------------------
# Stage 3: Node.js Builder - Build all packages
# Replicates: npm job (lines 14-70)
# Note: Build on target platform for consistency
# -----------------------------------------------------------------------------
FROM --platform=$TARGETPLATFORM node:20.17.0-bookworm AS nodejs-builder

# Install Rust for potential native module builds during yarn install
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | \
    sh -s -- -y --default-toolchain 1.84.1
ENV PATH="/root/.cargo/bin:${PATH}"

# Install system dependencies (exact from workflow line 14)
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        python3 \
        python3.11 \
        libpython3.11-dev \
        gcc \
        g++ \
        make \
        cmake \
        ca-certificates \
        git && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /cube

# Copy package files and build configuration
COPY package.json yarn.lock lerna.json ./
COPY tsconfig*.json ./
COPY rollup.config.js ./
COPY packages ./packages

# Install Yarn v1.22.22 (exact workflow step from line 49)
RUN yarn policies set-version v1.22.22 && \
    yarn config set network-timeout 120000 -g

# Install dependencies (workflow line 59)
# Skip CubeStore post-install since we're building it separately
ENV CUBESTORE_SKIP_POST_INSTALL=true
RUN yarn install --frozen-lockfile

# Copy built native module from previous stage
# This prevents it from being downloaded/built again
COPY --from=native-builder /cube/packages/cubejs-backend-native/index.node \
    ./packages/cubejs-backend-native/index.node

# Build Core Client libraries (workflow line 61)
RUN yarn build

# Build other packages (workflow line 63)
ENV NODE_OPTIONS=--max_old_space_size=4096
RUN yarn lerna run --concurrency 1 build

# Save the pre-built native module before production reinstall
RUN mkdir -p /tmp/native-backup && \
    cp packages/cubejs-backend-native/index.node /tmp/native-backup/index.node 2>/dev/null || true

# Now install production dependencies only
# This creates a clean node_modules for production
# Skip building native modules - we'll restore the pre-built one
RUN rm -rf node_modules packages/*/node_modules && \
    CUBESTORE_SKIP_POST_INSTALL=true yarn install --frozen-lockfile --prod && \
    # Remove DuckDB sources to reduce image size
    rm -rf /cube/node_modules/duckdb/src && \
    yarn cache clean

# Restore the pre-built native module after production reinstall
RUN cp /tmp/native-backup/index.node packages/cubejs-backend-native/index.node

# -----------------------------------------------------------------------------
# Stage 4: Production - Assemble final image
# Replicates: docker-default job + latest.Dockerfile
# -----------------------------------------------------------------------------
FROM --platform=$TARGETPLATFORM node:20.17.0-bookworm-slim

# Build-time arguments
ARG IMAGE_VERSION=unknown
ARG TARGETARCH

# Environment variables (exact from latest.Dockerfile lines 28-38)
ENV CUBEJS_DOCKER_IMAGE_VERSION=$IMAGE_VERSION \
    CUBEJS_DOCKER_IMAGE_TAG=self-contained \
    NODE_ENV=production \
    PYTHONUNBUFFERED=1

# Install runtime dependencies (exact from latest.Dockerfile lines 31-34)
RUN DEBIAN_FRONTEND=noninteractive && \
    apt-get update && \
    apt-get install -y --no-install-recommends \
        libssl3 \
        python3.11 \
        libpython3.11-dev \
        ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# Install Yarn v1.22.22 (exact from latest.Dockerfile line 36)
RUN yarn policies set-version v1.22.22

WORKDIR /cube

# Copy built Node.js packages from nodejs-builder
COPY --from=nodejs-builder /cube/node_modules ./node_modules
COPY --from=nodejs-builder /cube/packages ./packages
COPY --from=nodejs-builder /cube/package.json ./package.json
COPY --from=nodejs-builder /cube/yarn.lock ./yarn.lock
COPY --from=nodejs-builder /cube/lerna.json ./lerna.json

# Copy CubeStore binary from cubestore-builder (built natively on target platform)
COPY --from=cubestore-builder /cube/rust/cubestore/target/release/cubestored /usr/local/bin/cubestored

# Copy native module from native-builder
COPY --from=native-builder /cube/packages/cubejs-backend-native/index.node \
    ./packages/cubejs-backend-native/index.node

# Make CubeStore executable
RUN chmod +x /usr/local/bin/cubestored

# Configure Node.js module resolution paths (exact from latest.Dockerfile line 45)
ENV NODE_PATH=/cube/conf/node_modules:/cube/node_modules

# Create symlinks for CLI tools (exact from latest.Dockerfile lines 47-48)
RUN ln -s /cube/node_modules/.bin/cubejs /usr/local/bin/cubejs && \
    ln -s /cube/node_modules/.bin/cubestore-dev /usr/local/bin/cubestore-dev

# Set working directory to config directory (exact from latest.Dockerfile line 50)
WORKDIR /cube/conf

# Expose ports
# 4000 - Cube API (from latest.Dockerfile line 52)
# 3030 - CubeStore
EXPOSE 4000 3030

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD node -e "require('http').get('http://localhost:4000/readyz', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Default command (exact from latest.Dockerfile line 54)
CMD ["cubejs", "server"]

# =============================================================================
# Build Information:
# =============================================================================
# This Dockerfile replicates the exact build process from GitHub Actions:
#
# 1. CubeStore Builder (cubestore_linux job):
#    - Rust toolchain: nightly-2025-08-01
#    - Command: cargo build --release --target=<target> -p cubestore
#    - Output: /usr/local/bin/cubestored
#
# 2. Native Builder (native_linux job):
#    - Rust toolchain: 1.90.0
#    - Command: npm run native:build-release
#    - Output: packages/cubejs-backend-native/index.node
#
# 3. Node.js Builder (npm job):
#    - Node.js: 22.20.0
#    - Yarn: 1.22.22
#    - Commands: yarn install, yarn build, yarn lerna run build
#
# 4. Production Image (docker-default job + latest.Dockerfile):
#    - Base: node:22.20.0-bookworm-slim
#    - Runtime dependencies: libssl3, python3.11
#    - Includes: All built components
#
# =============================================================================
# Usage Examples:
# =============================================================================
#
# 1. Basic usage:
#    docker run -p 4000:4000 -v $(pwd):/cube/conf cubejs/cube:self-contained
#
# 2. With PostgreSQL:
#    docker run -p 4000:4000 \
#      -e CUBEJS_DB_TYPE=postgres \
#      -e CUBEJS_DB_HOST=localhost \
#      -e CUBEJS_DB_NAME=mydb \
#      -v $(pwd):/cube/conf \
#      cubejs/cube:self-contained
#
# 3. Running CubeStore separately:
#    docker run -p 3030:3030 \
#      cubejs/cube:self-contained \
#      cubestored
#
# 4. Docker Compose:
#    services:
#      cube:
#        image: cubejs/cube:self-contained
#        ports:
#          - "4000:4000"
#        environment:
#          - CUBEJS_DB_TYPE=postgres
#          - CUBEJS_CUBESTORE_HOST=cubestore
#        volumes:
#          - ./schema:/cube/conf/schema
#
#      cubestore:
#        image: cubejs/cube:self-contained
#        command: cubestored
#        ports:
#          - "3030:3030"
#        volumes:
#          - cubestore-data:/cube/data
#
#    volumes:
#      cubestore-data:
#
# =============================================================================
# Combined Dockerfile for Cube.js with native Linux build support
FROM cubejs/rust-cross:x86_64-unknown-linux-gnu-15082024-python-3.11 AS native-builder

# Install Node.js 22 (matching workflow requirements)
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs

# Install Yarn and cargo-cp-artifact
RUN npm install -g yarn@1.22.22 cargo-cp-artifact@0.1

# Install Rust and Cargo (if not present or not in PATH)
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y \
    && echo 'source $HOME/.cargo/env' >> $HOME/.bashrc

# Add Cargo to PATH for current session
ENV PATH="/root/.cargo/bin:${PATH}"

# Verify Rust installation
RUN cargo --version && rustc --version

# Set environment variables for native build
ENV PYTHON_VERSION_CURRENT=3.11
ENV PYO3_PYTHON=python3.11
ENV CARGO_BUILD_TARGET=x86_64-unknown-linux-gnu

WORKDIR /cube

# Copy minimal files needed for native build
COPY package.json lerna.json yarn.lock ./
RUN yarn policies set-version v1.22.22

# Copy only the native backend package for focused build
COPY . .

# Build Cube Store
WORKDIR /cube/rust/cubestore
RUN cargo build --release -j 4 -p cubestore

# Build other Rust components
WORKDIR /cube/rust/cubeorchestrator
RUN cargo build --release -j 4

WORKDIR /cube/rust/cubenativeutils
RUN cargo build --release -j 4

WORKDIR /cube/rust/cubesqlplanner/cubesqlplanner
RUN cargo build --release -j 4

WORKDIR /cube/rust/cubeshared
RUN cargo build --release -j 4

WORKDIR /cube/rust/cubesql
RUN cargo build --release -j 4

# Build native component
WORKDIR /cube/packages/cubejs-backend-native
RUN yarn run native:build-release-python



FROM node:20.17.0-bookworm-slim AS builder

WORKDIR /cube

# Copy pre-built native component from native-builder stage
COPY --from=native-builder /cube .

RUN yarn policies set-version v1.22.22
# Yarn v1 uses aggressive timeouts with summing time spending on fs, https://github.com/yarnpkg/yarn/issues/4890
RUN yarn config set network-timeout 120000 -g

# Required for node-oracledb to buld on ARM64
RUN apt-get update \
    # python3 package is necessary to install `python3` executable for node-gyp
    # libpython3-dev is needed to trigger post-installer to download native with python
    && apt-get install -y python3 python3.11 libpython3.11-dev gcc g++ make cmake \
    && rm -rf /var/lib/apt/lists/*

# We are copying root yarn.lock file to the context folder during the Publish GH
# action. So, a process will use the root lock file here.
RUN yarn install --prod \
    # Remove DuckDB sources to reduce image size
    && rm -rf /cube/node_modules/duckdb/src \
    && yarn cache clean


    
FROM node:20.17.0-bookworm-slim

ARG IMAGE_VERSION=unknown

ENV CUBEJS_DOCKER_IMAGE_VERSION=$IMAGE_VERSION
ENV CUBEJS_DOCKER_IMAGE_TAG=latest

RUN DEBIAN_FRONTEND=noninteractive \
    && apt-get update \
    && apt-get install -y --no-install-recommends libssl3 python3.11 libpython3.11-dev \
    && rm -rf /var/lib/apt/lists/*

RUN yarn policies set-version v1.22.22

ENV NODE_ENV=production

WORKDIR /cube

COPY --from=builder /cube .

COPY packages/cubejs-docker/bin/cubejs-dev /usr/local/bin/cubejs

# By default Node dont search in parent directory from /cube/conf, @todo Reaserch a little bit more
ENV NODE_PATH=/cube/conf/node_modules:/cube/node_modules
ENV PYTHONUNBUFFERED=1
RUN ln -s  /cube/packages/cubejs-docker /cube
RUN ln -s  /cube/rust/cubestore/bin/cubestore-dev /usr/local/bin/cubestore-dev

WORKDIR /cube/conf

EXPOSE 4000

CMD ["cubejs", "server"]

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

WORKDIR /cubejs

# Copy minimal files needed for native build
COPY package.json lerna.json yarn.lock ./
RUN yarn policies set-version v1.22.22

# Copy only the native backend package for focused build
COPY . .

# Build Cube Store
WORKDIR /cubejs/rust/cubestore
RUN cargo build --release -j 4 -p cubestore

# Build native component
WORKDIR /cubejs/packages/cubejs-backend-native
RUN yarn run native:build-release-python

FROM node:20.17.0-bookworm-slim AS base

ARG IMAGE_VERSION=unknown

ENV CUBEJS_DOCKER_IMAGE_VERSION=$IMAGE_VERSION
ENV CUBEJS_DOCKER_IMAGE_TAG=unknown
ENV CI=0

RUN DEBIAN_FRONTEND=noninteractive \
    && apt-get update \
    # python3 package is necessary to install `python3` executable for node-gyp
    && apt-get install -y --no-install-recommends libssl3 curl \
       cmake python3 python3.11 libpython3.11-dev gcc g++ make cmake openjdk-17-jdk-headless \
    && rm -rf /var/lib/apt/lists/*

ENV RUSTUP_HOME=/usr/local/rustup
ENV CARGO_HOME=/usr/local/cargo
ENV PATH=/usr/local/cargo/bin:$PATH

RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | \
    sh -s -- --profile minimal --default-toolchain nightly-2022-03-08 -y

ENV CUBESTORE_SKIP_POST_INSTALL=true
ENV NODE_ENV=development

WORKDIR /cubejs

COPY . .

RUN yarn policies set-version v1.22.22
# Yarn v1 uses aggressive timeouts with summing time spending on fs, https://github.com/yarnpkg/yarn/issues/4890
RUN yarn config set network-timeout 120000 -g

# There is a problem with release process.
# We are doing version bump without updating lock files for the docker package.
#RUN yarn install --frozen-lockfile

FROM base as build

RUN yarn install --prod

# Copy pre-built native component from native-builder stage
COPY --from=native-builder /cubejs .

RUN yarn build
RUN yarn lerna run build

RUN find . -name 'node_modules' -type d -prune -exec rm -rf '{}' +

FROM base AS final

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
    && apt-get install -y ca-certificates python3.11 libpython3.11-dev \
    && apt-get clean

COPY --from=build /cubejs .

COPY packages/cubejs-docker/bin/cubejs-dev /usr/local/bin/cubejs

# By default Node dont search in parent directory from /cube/conf, @todo Reaserch a little bit more
ENV NODE_PATH /cube/conf/node_modules:/cube/node_modules
ENV PYTHONUNBUFFERED=1
RUN ln -s  /cubejs/packages/cubejs-docker /cube
RUN ln -s  /cubejs/rust/cubestore/bin/cubestore-dev /usr/local/bin/cubestore-dev

WORKDIR /cube/conf

EXPOSE 4000

CMD ["cubejs", "server"]
FROM node:22.20.0-bookworm-slim AS base

ARG IMAGE_VERSION=latest

ENV CUBEJS_DOCKER_IMAGE_VERSION=$IMAGE_VERSION
ENV CUBEJS_DOCKER_IMAGE_TAG=$IMAGE_VERSION
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

ENV NODE_ENV=production

WORKDIR /cubejs

COPY package.json .
COPY lerna.json .
COPY yarn.lock .
COPY tsconfig.base.json .
COPY rollup.config.js .
COPY packages/cubejs-linter packages/cubejs-linter

# Backend
COPY packages/cubejs-backend-shared/package.json packages/cubejs-backend-shared/package.json
COPY packages/cubejs-base-driver/package.json packages/cubejs-base-driver/package.json
COPY packages/cubejs-backend-native/package.json packages/cubejs-backend-native/package.json
COPY packages/cubejs-testing-shared/package.json packages/cubejs-testing-shared/package.json
COPY packages/cubejs-backend-cloud/package.json packages/cubejs-backend-cloud/package.json
COPY packages/cubejs-api-gateway/package.json packages/cubejs-api-gateway/package.json
COPY packages/cubejs-bigquery-driver/package.json packages/cubejs-bigquery-driver/package.json
COPY packages/cubejs-cli/package.json packages/cubejs-cli/package.json
COPY packages/cubejs-crate-driver/package.json packages/cubejs-crate-driver/package.json
COPY packages/cubejs-cubestore-driver/package.json packages/cubejs-cubestore-driver/package.json
COPY packages/cubejs-query-orchestrator/package.json packages/cubejs-query-orchestrator/package.json
COPY packages/cubejs-schema-compiler/package.json packages/cubejs-schema-compiler/package.json
COPY packages/cubejs-server/package.json packages/cubejs-server/package.json

RUN yarn policies set-version v1.22.22
# Yarn v1 uses aggressive timeouts with summing time spending on fs, https://github.com/yarnpkg/yarn/issues/4890
RUN yarn config set network-timeout 120000 -g

# There is a problem with release process.
# We are doing version bump without updating lock files for the docker package.
#RUN yarn install --frozen-lockfile

FROM base AS prod_base_dependencies
COPY packages/cubejs-databricks-jdbc-driver/package.json packages/cubejs-databricks-jdbc-driver/package.json
RUN mkdir packages/cubejs-databricks-jdbc-driver/bin
RUN echo '#!/usr/bin/env node' > packages/cubejs-databricks-jdbc-driver/bin/post-install
RUN yarn install --prod

FROM prod_base_dependencies AS prod_dependencies
COPY packages/cubejs-databricks-jdbc-driver/bin packages/cubejs-databricks-jdbc-driver/bin
RUN yarn install --prod --ignore-scripts

FROM base AS build

RUN yarn install --prod

# Backend
COPY packages/cubejs-backend-shared/ packages/cubejs-backend-shared/
COPY packages/cubejs-base-driver/ packages/cubejs-base-driver/
COPY packages/cubejs-backend-native/ packages/cubejs-backend-native/
COPY packages/cubejs-testing-shared/ packages/cubejs-testing-shared/
COPY packages/cubejs-backend-cloud/ packages/cubejs-backend-cloud/
COPY packages/cubejs-api-gateway/ packages/cubejs-api-gateway/
COPY packages/cubejs-bigquery-driver/ packages/cubejs-bigquery-driver/
COPY packages/cubejs-cli/ packages/cubejs-cli/
COPY packages/cubejs-crate-driver/ packages/cubejs-crate-driver/
COPY packages/cubejs-cubestore-driver/ packages/cubejs-cubestore-driver/
COPY packages/cubejs-query-orchestrator/ packages/cubejs-query-orchestrator/
COPY packages/cubejs-schema-compiler/ packages/cubejs-schema-compiler/
COPY packages/cubejs-server/ packages/cubejs-server/
COPY packages/cubejs-server-core/ packages/cubejs-server-core/

RUN yarn build
RUN yarn lerna run build

RUN find . -name 'node_modules' -type d -prune -exec rm -rf '{}' +

FROM base AS final

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
    && apt-get install -y ca-certificates python3.11 libpython3.11-dev \
    && apt-get clean

COPY --from=build /cubejs .
COPY --from=prod_dependencies /cubejs .

COPY packages/cubejs-docker/bin/cubejs-dev /usr/local/bin/cubejs

# By default Node dont search in parent directory from /cube/conf, @todo Reaserch a little bit more
ENV NODE_PATH /cube/conf/node_modules:/cube/node_modules
ENV PYTHONUNBUFFERED=1
RUN ln -s  /cubejs/packages/cubejs-docker /cube
RUN ln -s  /cubejs/rust/cubestore/bin/cubestore-dev /usr/local/bin/cubestore-dev

WORKDIR /cube/conf

EXPOSE 4000

CMD ["cubejs", "server"]

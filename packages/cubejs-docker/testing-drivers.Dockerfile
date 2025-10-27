######################################################################
# Base image                                                         #
######################################################################
FROM cubejs/cube:latest AS base

ARG IMAGE_VERSION=latest

ENV CUBEJS_DOCKER_IMAGE_VERSION=$IMAGE_VERSION
ENV CUBEJS_DOCKER_IMAGE_TAG=latest

ENV CI=0

RUN DEBIAN_FRONTEND=noninteractive \
    && apt-get update \
    && apt-get install -y --no-install-recommends libssl3 curl \
       cmake python3 gcc g++ make cmake openjdk-17-jdk-headless unzip \
    && rm -rf /var/lib/apt/lists/*

ENV CUBESTORE_SKIP_POST_INSTALL=true
ENV NODE_ENV=development

WORKDIR /cubejs

# Backend
COPY --from=base /cube /cubejs

COPY packages/cubejs-bigquery-driver/package.json packages/cubejs-bigquery-driver/package.json

RUN yarn policies set-version v1.22.22
RUN yarn config set network-timeout 120000 -g

######################################################################
# Build dependencies                                                 #
######################################################################
FROM base AS build

RUN yarn install

# Backend

COPY packages/cubejs-bigquery-driver/ packages/cubejs-bigquery-driver/

RUN yarn build
RUN yarn lerna run build

ENV NODE_ENV=production

RUN find . -name 'node_modules' -type d -prune -exec rm -rf '{}' +

######################################################################
# Final image                                                        #
######################################################################
FROM build AS final

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
    && apt-get install -y ca-certificates python3.11 libpython3.11-dev \
    && apt-get clean

COPY --from=build /cubejs .

COPY packages/cubejs-docker/bin/cubejs-dev /usr/local/bin/cubejs

# By default Node dont search in parent directory from /cube/conf, @todo Reaserch a little bit more
ENV NODE_PATH /build/conf/node_modules:/build/node_modules
RUN ln -s  /cubejs/packages/cubejs-docker /build
RUN ln -s  /cubejs/rust/cubestore/bin/cubestore-dev /usr/local/bin/cubestore-dev

WORKDIR /build/conf

EXPOSE 4000

CMD ["cubejs", "server"]

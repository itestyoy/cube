ARG DEV_BUILD_IMAGE=cubejs/cube:latest

FROM $DEV_BUILD_IMAGE AS build
FROM node:22.20.0-bookworm-slim

ARG IMAGE_VERSION=latest

ENV CUBEJS_DOCKER_IMAGE_VERSION=$IMAGE_VERSION
ENV CUBEJS_DOCKER_IMAGE_TAG=latest

RUN DEBIAN_FRONTEND=noninteractive \
    && apt-get update \
    && apt-get install -y --no-install-recommends libssl3 python3 python3.11 libpython3.11-dev ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production

WORKDIR /cube
COPY --from=build /cube /cube

COPY packages/cubejs-bigquery-driver/ /cube-build/packages/cubejs-bigquery-driver/

RUN yarn policies set-version v1.22.22
RUN yarn config set network-timeout 120000 -g

# Required for node-oracledb to build on ARM64
RUN apt-get update \
    && apt-get install -y gcc g++ make cmake \
    && rm -rf /var/lib/apt/lists/*

# Собираем ваш драйвер BigQuery и регистрируем его через yarn link
RUN cd /cube-build/packages/cubejs-bigquery-driver/ && \
    yarn install && \
    yarn build && \
    yarn link

# Устанавливаем зависимости основного проекта
RUN yarn install --prod && yarn cache clean

# Линкуем ваш драйвер вместо стандартного
RUN cd /cube && yarn link "@cubejs-backend/bigquery-driver"

ENV NODE_PATH /cube/conf/node_modules:/cube/node_modules
ENV PYTHONUNBUFFERED=1
RUN ln -s /cube/node_modules/.bin/cubejs /usr/local/bin/cubejs
RUN ln -s /cube/node_modules/.bin/cubestore-dev /usr/local/bin/cubestore-dev

WORKDIR /cube/conf

EXPOSE 4000

CMD ["cubejs", "server"]
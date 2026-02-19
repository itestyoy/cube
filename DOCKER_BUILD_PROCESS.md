# Процесс сборки Docker образов для Cube

## Обзор

Cube использует GitHub Actions для автоматической сборки и публикации Docker образов в Docker Hub при создании новых релизов.

## GitHub Workflow

### Файл: `.github/workflows/publish.yml`

#### Триггеры

Workflow запускается при создании тегов:
```yaml
on:
  push:
    tags:
      - 'v*.*.*'      # Например: v1.5.14
      - 'v*.*.*-*'    # Например: v1.5.14-beta.1
```

#### Jobs для Docker

### 1. Job: `docker-default`

**Назначение:** Сборка основного Debian-based образа

**Параметры:**
- **Платформы:** `linux/amd64`, `linux/arm64`
- **Dockerfile:** `packages/cubejs-docker/latest.Dockerfile`
- **Контекст:** `packages/cubejs-docker/`
- **Registry:** Docker Hub (`cubejs/cube`)

**Зависимости:**
- `npm` - публикация npm пакетов должна завершиться
- `cubestore_linux` - нативные бинарники CubeStore
- `native_linux` - нативные Node.js модули
- `detect_branch` - определение ветки для тегирования

**Процесс:**

```yaml
steps:
  # 1. Checkout кода
  - uses: actions/checkout@v4

  # 2. Подготовка метаданных для Docker Hub
  - name: Repo metadata
    uses: actions/github-script@v7

  # 3. Определение тегов для образа
  - name: Prepare
    # Создает теги типа:
    # - v1.5.14
    # - v1.5
    # - v1
    # - latest (если master ветка)

  # 4. Логин в Docker Hub
  - name: Login to DockerHub
    uses: docker/login-action@v3
    with:
      username: ${{ secrets.DOCKERHUB_USERNAME }}
      password: ${{ secrets.DOCKERHUB_TOKEN }}

  # 5. Настройка QEMU для мультиплатформенной сборки
  - name: Set up QEMU
    uses: docker/setup-qemu-action@v3

  # 6. Настройка Docker Buildx
  - name: Set up Docker Buildx
    uses: docker/setup-buildx-action@v3

  # 7. Копирование yarn.lock в контекст сборки
  - name: Copy yarn.lock file
    run: cp yarn.lock packages/cubejs-docker

  # 8. Сборка и публикация образа
  - name: Push to Docker Hub
    uses: docker/build-push-action@v6
    with:
      context: ./packages/cubejs-docker
      file: ./packages/cubejs-docker/latest.Dockerfile
      platforms: linux/amd64,linux/arm64
      push: true
      tags: ${{ steps.prep.outputs.tags }}
```

### 2. Job: `docker-debian-jdk`

**Назначение:** Сборка образа с JDK (для JDBC драйверов)

**Отличия от основного:**
- Включает OpenJDK для JDBC драйверов (Databricks, etc.)
- Dockerfile: `latest-debian-jdk.Dockerfile`
- Теги с суффиксом `-jdk` (например: `cubejs/cube:v1.5.14-jdk`)
- Только платформа `linux/amd64`

### 3. Job: `docker-cubestore`

**Назначение:** Сборка образа CubeStore (OLAP engine)

**Параметры:**
- Матрица для разных архитектур и конфигураций:
  - `x86_64` с AVX2
  - `x86_64` без AVX2 (для старых процессоров)
  - `arm64v8`
- Dockerfile: `rust/cubestore/Dockerfile`
- Registry: `cubejs/cubestore`

## Структура образа

### Multi-stage build

#### Stage 1: Builder

```dockerfile
FROM node:22.20.0-bookworm-slim AS builder

WORKDIR /cube
COPY . .

# Установка Yarn
RUN yarn policies set-version v1.22.22

# Установка системных зависимостей
RUN apt-get update && \
    apt-get install -y python3 python3.11 libpython3.11-dev gcc g++ make cmake

# Установка Node.js зависимостей
RUN yarn install --prod
```

**Что происходит:**
1. Копируется весь код проекта
2. Устанавливается Yarn v1.22.22
3. Устанавливаются системные зависимости для компиляции нативных модулей
4. Устанавливаются все production зависимости из `package.json`
5. Очищается кеш Yarn

#### Stage 2: Production

```dockerfile
FROM node:22.20.0-bookworm-slim

ARG IMAGE_VERSION=unknown
ENV CUBEJS_DOCKER_IMAGE_VERSION=$IMAGE_VERSION
ENV NODE_ENV=production

# Установка runtime зависимостей
RUN apt-get update && \
    apt-get install -y libssl3 python3.11 libpython3.11-dev

# Копирование собранных модулей
COPY --from=builder /cube .

# Настройка окружения
ENV NODE_PATH=/cube/conf/node_modules:/cube/node_modules
RUN ln -s /cube/node_modules/.bin/cubejs /usr/local/bin/cubejs

WORKDIR /cube/conf
EXPOSE 4000
CMD ["cubejs", "server"]
```

**Что происходит:**
1. Копируются только собранные `node_modules` из builder stage
2. Устанавливаются минимальные runtime зависимости
3. Создаются symlinks для CLI инструментов
4. Настраивается рабочая директория `/cube/conf` (для пользовательских конфигураций)

## Пакеты в образе

Файл `packages/cubejs-docker/package.json` содержит все драйверы БД:

```json
{
  "dependencies": {
    "@cubejs-backend/athena-driver": "1.5.14",
    "@cubejs-backend/bigquery-driver": "1.5.14",
    "@cubejs-backend/clickhouse-driver": "1.5.14",
    "@cubejs-backend/postgres-driver": "1.5.14",
    "@cubejs-backend/mysql-driver": "1.5.14",
    "@cubejs-backend/mssql-driver": "1.5.14",
    "@cubejs-backend/snowflake-driver": "1.5.14",
    "@cubejs-backend/server": "1.5.14",
    "cubejs-cli": "1.5.14",
    // ... и многие другие драйверы
  }
}
```

## Тегирование образов

### Логика тегов

При релизе `v1.5.14` создаются следующие теги:

```bash
cubejs/cube:v1.5.14   # Полная версия
cubejs/cube:v1.5      # Минорная версия
cubejs/cube:v1        # Мажорная версия
cubejs/cube:latest    # Если это master ветка
```

Для JDK варианта:
```bash
cubejs/cube:v1.5.14-jdk
cubejs/cube:v1.5-jdk
cubejs/cube:v1-jdk
cubejs/cube:jdk
```

### Метаданные образа

Образы содержат OCI labels:
```yaml
labels:
  org.opencontainers.image.title: cube
  org.opencontainers.image.description: Semantic Layer for building data apps
  org.opencontainers.image.version: v1.5.14
  org.opencontainers.image.created: 2025-01-01T00:00:00Z
  org.opencontainers.image.revision: <git-sha>
  org.opencontainers.image.licenses: Apache-2.0
```

## Локальная сборка

### Сборка для одной платформы

```bash
# Из корня репозитория
docker build \
  -f packages/cubejs-docker/latest.Dockerfile \
  -t cubejs/cube:local \
  --build-arg IMAGE_VERSION=local \
  packages/cubejs-docker/
```

### Мультиплатформенная сборка

```bash
# Создание buildx builder
docker buildx create --name multiplatform --use

# Сборка для AMD64 и ARM64
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -f packages/cubejs-docker/latest.Dockerfile \
  -t cubejs/cube:local \
  --build-arg IMAGE_VERSION=local \
  --push \
  packages/cubejs-docker/
```

### Сборка с использованием нового Dockerfile

```bash
# Используя Dockerfile.production из корня
docker build \
  -f Dockerfile.production \
  -t cubejs/cube:custom \
  --build-arg IMAGE_VERSION=custom \
  .
```

## Использование образа

### Docker run

```bash
docker run -d \
  --name cube \
  -p 4000:4000 \
  -e CUBEJS_DB_TYPE=postgres \
  -e CUBEJS_DB_HOST=localhost \
  -e CUBEJS_DB_NAME=mydb \
  -e CUBEJS_DB_USER=user \
  -e CUBEJS_DB_PASS=password \
  -v $(pwd)/schema:/cube/conf/schema \
  cubejs/cube:latest
```

### Docker Compose

```yaml
version: '3.8'

services:
  cube:
    image: cubejs/cube:latest
    ports:
      - "4000:4000"
    environment:
      - CUBEJS_DB_TYPE=postgres
      - CUBEJS_DB_HOST=db
      - CUBEJS_DB_NAME=mydb
      - CUBEJS_DB_USER=cube
      - CUBEJS_DB_PASS=password
      - CUBEJS_DEV_MODE=true
    volumes:
      - ./schema:/cube/conf/schema
      - ./node_modules:/cube/conf/node_modules
    depends_on:
      - db

  db:
    image: postgres:15
    environment:
      - POSTGRES_USER=cube
      - POSTGRES_PASSWORD=password
      - POSTGRES_DB=mydb
    volumes:
      - postgres-data:/var/lib/postgresql/data

volumes:
  postgres-data:
```

## Оптимизация размера образа

### Текущие меры:

1. **Multi-stage build** - builder stage не попадает в финальный образ
2. **Minimal base image** - `node:22-bookworm-slim` вместо `node:22`
3. **Очистка кеша** - `yarn cache clean` после установки
4. **Удаление исходников** - DuckDB sources удаляются
5. **Минимальные runtime зависимости** - только libssl3, python3.11

### Размеры образов:

- `cubejs/cube:latest` - ~1.5GB (включает все драйверы)
- `cubejs/cube:latest-jdk` - ~2.0GB (+ JDK)
- `cubejs/cubestore:latest` - ~200MB (Rust binary)

## Проблемы и решения

### 1. Нативные модули

**Проблема:** Некоторые драйверы (Oracle, DuckDB) требуют компиляции нативных модулей

**Решение:**
- Установка build tools в builder stage
- Установка runtime dependencies (libpython3-dev) в production stage

### 2. Мультиплатформенная сборка

**Проблема:** ARM64 образы требуют QEMU эмуляции

**Решение:**
- Использование `docker/setup-qemu-action@v3`
- Использование `docker/buildx` для мультиплатформенной сборки

### 3. Размер образа

**Проблема:** Большой размер из-за множества драйверов

**Решение:**
- Multi-stage build для минимизации слоев
- Очистка ненужных файлов (sources, cache)
- Использование slim базового образа

## Мониторинг и отладка

### Просмотр содержимого образа

```bash
# Запустить shell в контейнере
docker run -it --rm cubejs/cube:latest /bin/bash

# Проверить установленные пакеты
docker run --rm cubejs/cube:latest npm list --depth=0

# Проверить версию
docker run --rm cubejs/cube:latest node -e "console.log(process.env.CUBEJS_DOCKER_IMAGE_VERSION)"
```

### Health check

```bash
# Проверить health status
docker inspect --format='{{.State.Health.Status}}' <container-id>

# Посмотреть логи health check
docker inspect --format='{{json .State.Health}}' <container-id> | jq
```

## Дополнительные ресурсы

- [Cube Documentation](https://cube.dev/docs)
- [Docker Hub - cubejs/cube](https://hub.docker.com/r/cubejs/cube)
- [GitHub Actions Workflow](.github/workflows/publish.yml)
- [Dockerfile Latest](packages/cubejs-docker/latest.Dockerfile)

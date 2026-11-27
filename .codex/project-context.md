# Старт Task 10 на готовой Task 9

## Checkout и база

- Ветка `feature/task-10-start`. Проверенная база после Task 9 — `0870040fe82de90e948ae52c14cea167cecd86a0`.
- Материалы в Obsidian: tasks/10-versioned-document-pipeline-and-hybrid-ai-search.md
  и guides/10-document-pipelines-embeddings-and-hybrid-search-primer.md.

## Контракты базы

- Nest feature modules, Prisma/PostgreSQL 16; обязательный Document.body, DTO content.
  Права и workspace isolation проверяются через access policy.
- READY-файлы документов в Yandex Object Storage. Redis обслуживает cache-aside.
  RabbitMQ/amqplib и transactional outbox обслуживают экспорты с confirms и manual ACK.
- Task 9: очищенные JSON-логи Pino и контекст OpenTelemetry проходят через Collector
  в Loki/Jaeger; Grafana читает оба источника, Prometheus собирает метрики Collector.
  API и worker передают W3C контекст через RabbitMQ. `obs:up` использует группу
  `nest-fullstack-project` с тестовой БД `task9_observability_test`.

## Задача и проверки

- Предстоит добавить versioned document pipeline и гибридный поиск по активным версиям.
  Сохранять текущую версию при сбое, проверять права и фильтровать кандидатов до LIMIT.
- Базовый Jest запускается обычной командой `npm run test:e2e --prefix backend`
  на выделенной тестовой БД. `npm run test:task9` проверяет готовую Task 9 на стенде.
- `npm run test:task10 -- --fixtures` показывает входы для приёмки. После реализации
  `npm run test:task10` запускает отдельный HTTP-контракт с `TASK10_CONTRACT_TESTS=true`,
  тестовыми авторизациями и подготовленными READY-файлами в двух workspace.
  Сценарий отказа новой версии включается указанием `TASK10_REJECTED_FILE_ID`.
  Имена переменных и требования к фикстурам указаны в тесте.

# Task 10. Версии документов и гибридный поиск

## База

- Рабочая ветка решения — `codex/linden-47`. Родитель — актуальный коммит `feature/task-10-start`; исходная проверенная основа старта — `a70a1b0` с готовой Task 9 `0870040`.
- Учебные материалы находятся в Obsidian, Task 10 и Guide 10. Состояние реализации и ссылки для проверки — в `docs/ai/10-document-pipeline-and-hybrid-search.md` в Obsidian.

## Реализация

- Загрузка READY-файла создаёт версию по хэшу файла. Outbox и отдельная очередь в RabbitMQ проходят EXTRACT → NORMALIZE → CHUNK → EMBED → INDEX → ACTIVATE. Право на запись проверяется в API и на стадии worker.
- PostgreSQL хранит фрагменты и pgvector. Поиск объединяет trigram по заголовку и поиск по смыслу через RRF, ограничивает обе выборки текущими версиями доступного workspace до LIMIT.
- Для проверки по умолчанию используется deterministic fake. Voyage подключается явно. Версии модели, покрытие, dual-write и откат хранятся в PostgreSQL.
- Сервисы работают в `nest-fullstack-project`. Обычный запуск — `npm run dev` или Docker Compose. Запись тестовых данных выполняется на выделенной БД.

## Проверки

- `npm run test:task10 -- --fixtures` показывает входы. Дальнейший `npm run test:task10` проверяет публичный HTTP-контракт с `TASK10_CONTRACT_TESTS=true`, синтетическими учётными записями и подготовленными READY-файлами.
- Расширенная приёмка, реальные проверки Voyage/Yandex и сопоставление Jaeger, Grafana и Prometheus описаны в материале Task 10 в Obsidian.

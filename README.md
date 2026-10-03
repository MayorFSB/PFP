# PFP — сеть парикмахерских (FastAPI portfolio, Middle+/Senior)

![ci](https://github.com/MayorFSB/PFP/actions/workflows/ci/badge.svg)

Полный цикл бэкенд-проекта: auth с ротацией refresh, RBAC, недельное расписание, бронь без
двойных записей (Postgres exclusion constraint), кэш Valkey, SSR + JSON API, оплата-заглушка,
Prometheus/Grafana/Loki, CI/CD, Helm + k8s демо через Cloudflare Tunnel.

Stack: Python 3.14 / FastAPI async / SQLAlchemy 2.0 / PostgreSQL 16 / Valkey / Docker / k3d + Helm.

## Демо

- Сайт: `https://geek-quick-cure-tremendous.trycloudflare.com` (quick tunnel, жив пока включён dev-ноут)
- Локально: см. «Быстрый старт» ниже, затем http://localhost:8000

Demo-аккаунты (пароль `demo1234`):

| Email | Роль |
|---|---|
| `client@demo.local` | клиент |
| `master00@demo.local` … `master11@demo.local` | мастера |
| `admin@demo.local` | админ (смена ролей) |

Сценарий за 1 минуту: Филиалы → Центр → у мастера «Слоты» → кнопка времени (бронь) → Кабинет.

![Филиалы](docs/img/index.png)
![Кабинет](docs/img/cabinet.png)

## Быстрый старт

```powershell
uv sync
docker compose up -d postgres valkey  # PG :5433, Valkey :6380 (порты хоста)
alembic upgrade head
uv run python -m app.modules.seed --clients 200 --visits 300
uv run uvicorn app.main:app --reload  # http://localhost:8000
```

Тесты (только на `pfp_test`, dev-БД не трогают):

```powershell
$env:PFP_DATABASE_URL="postgresql+asyncpg://pfp:pfp@localhost:5433/pfp_test"
uv run pytest -q
```

Проверки: `uv run ruff check .` · `uv run mypy app` · OpenAPI: `/docs` · Метрики: `/metrics`.

## Архитектура

```
browser ──► Traefik/k3d ──► app ×2 (FastAPI: SSR Jinja+HTMX ─┬─► PostgreSQL (exclusion no_double_book)
                             + JSON /api/v1)                └─► Valkey (слоты, gzip>1KB, TTL 120с)
               │ Metrics /metrics ──► Prometheus ──► Grafana (брони по филиалам, p95, hit ratio)
               │ Logs JSON ──► Loki
```

Ключевые решения:

- Пароли — только Argon2id (`pwdlib`) + server-side pepper. Access 15 мин + rotating refresh
  в httpOnly cookie, reuse detection сносит все сессии.
- Бронь: `Idempotency-Key` + `EXCLUDE USING gist (master WITH =, tstzrange WITH &&)` —
  двойная запись невозможна даже при гонке; повтор с тем же ключом возвращает ту же бронь.
- Слоты строятся из недельных `schedule_rules` минус занятое, лежат в Valkey, инвалидация по событию.
- Auth: login/password + Google OIDC + Telegram Login Widget (HMAC-проверка). Роли:
  client / master / moderator / admin.
- Фронт без сборки: SSR Jinja + HTMX + ~1KB своего CSS. API версионировано (`/api/v1`).
- Оплата — Strategy (`Provider` + `FakeProvider`), webhook идемпотентен.

## k8s демо

```powershell
k3d cluster create pfp --servers 1 --agents 2 -p "80:80@loadbalancer"
docker compose build app; docker tag pfp-app pfp:dev; k3d image import pfp:dev -c pfp
helm install pfp deploy/helm/pfp  # миграции — initContainer, RollingUpdate maxUnavailable: 0
cloudflared tunnel --url http://localhost:80
```

## Структура

```
app/core/      config, db, security(argon2), jwt, cache(valkey+gzip), metrics
app/modules/   auth, booking, payments, web(SSR), seed(faker)
app/migrations/ 0001..0005 (auth_sessions, schedule, profiles, exclusion, unique)
templates/ static/   SSR
deploy/helm/pfp      Helm chart
observability/       prometheus, grafana, loki, promtail
tests/             25 тестов (api + unit)
```

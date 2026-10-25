# PFP — сеть парикмахерских (FastAPI portfolio, Middle+/Senior)

![ci](https://github.com/MayorFSB/PFP/actions/workflows/ci/badge.svg)
![python](https://img.shields.io/badge/python-3.14-blue)

Полный цикл бэкенд-проекта: auth с ротацией refresh, RBAC, недельное расписание, бронь без
двойных записей (Postgres exclusion constraint), кэш Valkey, SSR + JSON API, оплата-заглушка,
Prometheus/Grafana/Loki, CI/CD, Helm + k8s демо через Cloudflare Tunnel.

Stack: Python 3.14 / FastAPI async / SQLAlchemy 2.0 / PostgreSQL 16 / Valkey / Docker / k3d + Helm.

Почему так, а не иначе — разбор ключевых решений: **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.

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
![Админка](docs/img/admin.png)

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

## Hero: 3D-симуляция мытья головы (three.js)

На главной — интерактивная 3D-сцена: ~300 волос-прядей с физикой (wet-clump, sag,
wash-flow), пена, пузыри, пар; «мойка» смывает грязь в реальном времени. Полностью
собственный код (без сборки, ES-модули): директор фаз, планировщик бюджета кадра
под iGPU, системы частиц, post-processing (ACES + bloom). Параметрический тюн
вынесен в JSON (`static/3d/look-wash.json`) — правки живут без пересборки.

![3D hero](docs/img/hero3d.png)

## Нагрузочное

`load/slots.js` (k6) — прогон эндпоинта слотов (кэш Valkey против БД):

```bash
k6 run load/slots.js
```

## Структура

```
app/core/        config, db, security(argon2id), jwt(+ротация refresh), cache(valkey+gzip), metrics, guard(CSP)
app/modules/
  auth/          пароли, Google OIDC, Telegram Login, роли, сессии с reuse detection
  booking/       слоты из schedule_rules, бронь (idempotency + exclusion), отмена
  payments/      Strategy: Provider + FakeProvider, идемпотентный webhook
  chat/          чат с управляющим (WS) + Gemma structured output
  loyalty.py     уровни, дни рождения, прогресс до следующего уровня
  perks.py       промокоды, семейные подписки, поинты, leaderboard мастеров
  web/           SSR-страницы: pages, auth_pages, cabinets, dashboards (+CSRF)
  seed.py        идемпотентный фейк-сид (200 клиентов, 300 визитов)
app/migrations/  0001..0007 + chat_messages (sessions, schedule, profiles, exclusion, perks)
static/3d/       three.js hero-сцена (hair, particles, phases, post)
templates/       Jinja SSR (cabinet, master, manager, admin, ...)
deploy/helm/pfp  Helm chart (миграции в initContainer, RollingUpdate)
observability/   prometheus, grafana (дашборд), loki, promtail
load/slots.js    k6-сценарий слотов
tests/           52 теста (API, SSR, JWT, слоты, пароли)
```

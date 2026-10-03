# PFP — сеть парикмахерских (FastAPI portfolio, Middle+/Senior)

Stack: Python 3.14 / FastAPI async / PostgreSQL 16 / Valkey / Docker / k8s (k3d) / Prometheus+Grafana+Loki.
Фронт: SSR Jinja + HTMX + Tailwind (MVP) + JSON API `/api/v1` для SPA.
Auth: login/password (Argon2id) + Google OIDC + Telegram Login. RBAC: client/master/moderator/admin.

## Быстрый старт (день 1)
```powershell
uv sync
docker compose up -d postgres valkey
alembic upgrade head
uv run uvicorn app.main:app --reload
```

## Демо через Cloudflare Tunnel (self-host)
```powershell
# k3d: 1 server + 2 agents, ~8GB RAM из 40GB доступных
k3d cluster create pfp --servers 1 --agents 2
kubectl apply -k deploy/k8s/overlays/dev
cloudflared tunnel --url http://localhost:80
```
Прод-вариант: `cloudflared` как Deployment в кластере + `Ingress nginx`.

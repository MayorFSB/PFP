# SECURITY.md

## Модель угроз

Демо-проект сети парикмахерских. Основные риски: кража сессий, брутфорс логина, XSS через
пользовательские данные, CSRF на мутациях, перебор слотов брони.

## Что закрыто

| Угроза | Защита |
|---|---|
| Перехват пароля | Argon2id (pwdlib) + server-side pepper, никаких sha256/md5 |
| Кража refresh-токена | Ротация + reuse detection: повтор отозванного jti сносит все сессии юзера |
| Брутфорс логина | Rate-limit 10/мин с IP через Valkey (fixed window), fail-open при недоступности Valkey |
| Timing oracle на логин | Фейковая argon2-проверка для несуществующих email |
| XSS | Jinja autoescape ON, CSP `default-src 'self'`, заголовок X-Content-Type-Options |
| CSRF | Double-submit: токен в cookie + скрытое поле формы, SameSite=Lax |
| Clickjacking | X-Frame-Options: DENY |
| SQLi | Параметризованные запросы SQLAlchemy 2.0, Pydantic-валидация UUID/date |
| Двойная бронь | Postgres exclusion constraint `btree_gist` + `tstzrange` |
| Идемпотентность | `Idempotency-Key` header, повтор возвращает ту же бронь |
| Секреты | Только env (`.env` в gitignore), pepper/jwt-secret из переменных окружения |

## Заголовки безопасности

Все ответы включают: `Content-Security-Policy`, `X-Frame-Options`, `X-Content-Type-Options`,
`Referrer-Policy`. Middleware: `app/core/guard.py`.

## Что НЕ закрыто (осознанно, для демо)

- HSTS — только за TLS-терминатором (Cloudflare/ingress), не на приложении
- fail2ban — на уровне ingress/nginx, не в приложении (rate-limit выше — приложенческий слой)
- 2FA/TOTP — не реализовано (задел в архитектуре)
- Аудит-лог действий админа — не реализован

## Как воспроизвести проверки

```powershell
# заголовки
uv run python -c "import httpx; r=httpx.get('http://127.0.0.1:8000/'); print(r.headers.get('content-security-policy'))"

# rate-limit: 11-й логин с того же IP → 429
uv run python -c "import httpx; c=httpx.Client(base_url='http://127.0.0.1:8000'); print([c.post('/api/v1/auth/login', json={'email':'x@example.com','password':'y'}).status_code for _ in range(12)][-2:])"

# CSRF: POST /book без токена → 403
uv run python -c "import httpx; print(httpx.post('http://127.0.0.1:8000/book', data={'master_id':'x'}).status_code)"
```

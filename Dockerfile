FROM ghcr.io/astral-sh/uv:python3.14-bookworm-slim AS base
WORKDIR /code
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY app ./app
COPY templates ./templates
COPY static ./static
COPY alembic.ini ./
ENV PATH="/code/.venv/bin:$PATH"
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]

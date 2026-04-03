FROM ghcr.io/astral-sh/uv:python3.13-trixie-slim AS builder

WORKDIR /app

# Install dependencies first (cached unless pyproject.toml/uv.lock change)
COPY pyproject.toml uv.lock ./
RUN uv sync --no-dev --no-install-project --frozen

# Copy source and install the project itself
COPY main.py ./
COPY src/ ./src/

# ── Runtime ───────────────────────────────────────────────────────────────────
FROM python:3.13-slim-trixie

WORKDIR /app

# Copy the virtual environment and source from the builder
COPY --from=builder /app/.venv /app/.venv
COPY --from=builder /app/main.py /app/main.py
COPY --from=builder /app/src /app/src

ENV PATH="/app/.venv/bin:$PATH"

EXPOSE 8000

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--log-level", "warning", "--no-access-log"]

FROM python:3.15.2-slim AS builder

WORKDIR /build

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    gcc \
    && rm -rf /var/lib/apt/lists/*

RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

COPY requirements.txt .

# install python dependencies
RUN pip install --upgrade pip
RUN pip install --no-cache-dir -r requirements.txt

FROM python:3.15.2-slim

ARG BUILD_DATE
ARG GIT_COMMIT

# set environment variables
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV PATH="/opt/venv/bin:$PATH"

# Copy virtual environment from the builder stage
WORKDIR /app
COPY --from=builder /opt/venv /opt/venv

COPY ./gunicorn.conf.py .
COPY ./app.py .
COPY ./templates ./templates
COPY ./static ./static

# Create a non-root user and set ownership of the application directory
RUN useradd -m appuser && chown -R appuser:appuser /app
USER appuser

EXPOSE 8000
# gunicorn
CMD ["gunicorn", "-c", "gunicorn.conf.py", "app:app"]

FROM python:3.11-slim
WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY src ./src
# PYTHONPATH points at src/ so cross-file imports like
# `from health_server import start_health_server` and
# `from channels.email_channel import EmailChannel` resolve at runtime.
ENV PYTHONPATH=/app/src
ENV PYTHONUNBUFFERED=1

EXPOSE 8080
# Script path is relative to WORKDIR (/app); PYTHONPATH lets cross-file
# imports inside the script resolve unprefixed.
CMD ["python", "-u", "src/worker.py"]

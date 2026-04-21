FROM python:3.11-slim
WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY src ./src
# PYTHONPATH points at src/ so cross-file imports like
# `from events_client import ApiEventsClient` and
# `from pitch_prompts import PITCH_PROMPTS` resolve at runtime.
ENV PYTHONPATH=/app/src
ENV PYTHONUNBUFFERED=1

EXPOSE 3001
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "3001", "--reload", "--reload-dir", "/app/src"]

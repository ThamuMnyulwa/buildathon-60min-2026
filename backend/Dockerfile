FROM python:3.12-slim

WORKDIR /app

RUN pip install --no-cache-dir fastapi google-cloud-bigquery python-multipart "uvicorn[standard]"

COPY main.py ./

ENV PORT=8080
EXPOSE 8080

CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT}"]

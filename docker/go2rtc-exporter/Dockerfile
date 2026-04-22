FROM python:3.11-alpine

WORKDIR /app

RUN pip install --no-cache-dir prometheus-client requests

COPY exporter.py .

EXPOSE 1985

CMD ["python", "exporter.py"]

FROM python:3.11-alpine

WORKDIR /app

RUN pip install --no-cache-dir prometheus-client pyyaml

COPY exporter.py .

EXPOSE 1986

CMD ["python", "exporter.py"]

FROM python:3.11-slim

ENV LANG=C.UTF-8
ENV LC_ALL=C.UTF-8
ENV PYTHONIOENCODING=utf-8

WORKDIR /app

RUN pip install --no-cache-dir requests pyyaml

COPY exporter.py .

CMD ["python", "exporter.py"]

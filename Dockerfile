FROM python:3.11-slim

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY climatemaps-master/requirements.txt .
RUN pip install --upgrade pip
RUN pip install --no-cache-dir -r requirements.txt

COPY climatemaps-master/climatemaps ./climatemaps
COPY climatemaps-master/setup.py .
COPY climatemaps-master/README.md .
RUN pip install --no-cache-dir .

COPY climatemaps-master/api/ ./api/

EXPOSE 8000

CMD ["sh", "-c", "uvicorn api.main:app --host 0.0.0.0 --port ${PORT:-8000}"]

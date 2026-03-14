FROM python:3.11-slim

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies
COPY requirements.txt .
RUN pip install --upgrade pip
RUN pip install --no-cache-dir -r requirements.txt

# Install climatemaps package
COPY climatemaps ./climatemaps
COPY setup.py .
COPY README.md .
RUN pip install --no-cache-dir .

# Copy the rest of your FastAPI app
COPY api/ ./api/

EXPOSE 8000

# 5. Run Uvicorn
CMD ["sh", "-c", "uvicorn api.main:app --host 0.0.0.0 --port ${PORT:-8000}"]

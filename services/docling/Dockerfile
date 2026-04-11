FROM python:3.11-slim

ARG TORCH_VERSION=2.7.1+cpu
ARG TORCHVISION_VERSION=0.22.1

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DEFAULT_TIMEOUT=300 \
    PIP_RETRIES=10

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        libglib2.0-0 \
        libsm6 \
        libx11-6 \
        libxext6 \
        libxrender1 \
        libxcb1 \
        libgl1 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./requirements.txt
RUN pip install --no-cache-dir --progress-bar off \
    --index-url https://download.pytorch.org/whl/cpu \
    "torch==${TORCH_VERSION}" \
    "torchvision==${TORCHVISION_VERSION}"
RUN pip install --no-cache-dir --progress-bar off -r requirements.txt

COPY app.py ./app.py

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8081"]
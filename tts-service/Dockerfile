FROM python:3.11-slim

WORKDIR /app

ENV PYTHONUNBUFFERED=1 \
    HF_HOME=/models/huggingface \
    TORCH_HOME=/models/torch

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg libsndfile1 \
  && rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY service.py ./

EXPOSE 8008
CMD ["uvicorn", "service:app", "--host", "0.0.0.0", "--port", "8008"]

# Chatterbox TTS Service

This service runs Chatterbox outside the Bun app. The app talks to it through
`CHATTERBOX_BASE_URL`.

## Host Run

Use Python 3.11. The current Chatterbox package is tested against Python 3.11,
not the system Python in every environment.

```sh
cd tts-service
python3.11 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
uvicorn service:app --host 127.0.0.1 --port 8008
```

For local Bun development, keep:

```sh
CHATTERBOX_BASE_URL=http://127.0.0.1:8008
```

For `streamer-tools` running in Docker while this service runs on the host, use:

```sh
CHATTERBOX_BASE_URL=http://host.docker.internal:8008
```

## Optional Docker Run

CPU:

```sh
docker compose -f compose.yml -f compose.chatterbox.yml up --build
```

NVIDIA GPU:

```sh
docker compose -f compose.yml -f compose.chatterbox.yml -f compose.gpu.yml up --build
```

GPU mode requires working host NVIDIA drivers and the NVIDIA Container Toolkit.

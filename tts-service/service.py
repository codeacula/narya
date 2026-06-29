import base64
from pathlib import Path
from tempfile import NamedTemporaryFile
from threading import Lock

import torch
import torchaudio as ta
from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field

from chatterbox.mtl_tts import ChatterboxMultilingualTTS


app = FastAPI(title="Narya Chatterbox TTS")
model = None
model_lock = Lock()
voice_conditionals = {}


class PrepareVoiceRequest(BaseModel):
    voiceId: str = Field(min_length=1)
    referencePath: str | None = None
    referenceAudioBase64: str | None = None
    model: str = "multilingual-v3"
    languageId: str = "en"


class SynthesizeRequest(BaseModel):
    text: str = Field(min_length=1, max_length=500)
    voiceId: str = "default"
    referencePath: str | None = None
    referenceAudioBase64: str | None = None
    model: str = "multilingual-v3"
    languageId: str = "en"
    exaggeration: float = 0.5
    cfgWeight: float = 0.5
    temperature: float = 0.8


def detect_device() -> str:
    if torch.cuda.is_available():
        return "cuda"
    if torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def get_model():
    global model
    if model is None:
        device = detect_device()
        model = ChatterboxMultilingualTTS.from_pretrained(device=device, t3_model="v3")
    return model


def write_reference_audio(reference_audio_base64: str) -> NamedTemporaryFile:
    try:
        audio = base64.b64decode(reference_audio_base64)
    except Exception as error:
        raise HTTPException(status_code=400, detail="Voice reference audio was not valid base64.") from error

    temp = NamedTemporaryFile(suffix=".wav")
    temp.write(audio)
    temp.flush()
    return temp


def resolve_reference(reference_path: str | None, reference_audio_base64: str | None):
    if reference_audio_base64:
        return write_reference_audio(reference_audio_base64)
    if not reference_path:
        return None
    path = Path(reference_path)
    if not path.exists() or not path.is_file():
        raise HTTPException(status_code=400, detail="Voice reference audio file was not found.")
    return str(path)


@app.get("/health")
def health():
    return {"ok": True, "loaded": model is not None, "device": detect_device()}


@app.post("/prepare-voice")
def prepare_voice(request: PrepareVoiceRequest):
    reference = resolve_reference(request.referencePath, request.referenceAudioBase64)
    reference_path = reference.name if hasattr(reference, "name") else reference
    try:
        with model_lock:
            tts = get_model()
            tts.prepare_conditionals(reference_path, exaggeration=0.5)
            voice_conditionals[request.voiceId] = tts.conds
        return {"ok": True}
    except HTTPException:
        raise
    except Exception as error:
        raise HTTPException(status_code=500, detail=f"Failed to prepare voice: {error}") from error
    finally:
        if hasattr(reference, "close"):
            reference.close()


@app.post("/synthesize")
def synthesize(request: SynthesizeRequest):
    reference = resolve_reference(request.referencePath, request.referenceAudioBase64)
    reference_path = reference.name if hasattr(reference, "name") else reference
    try:
        with model_lock:
            tts = get_model()
            if request.voiceId in voice_conditionals:
                tts.conds = voice_conditionals[request.voiceId]
                wav = tts.generate(
                    request.text,
                    language_id=request.languageId,
                    exaggeration=request.exaggeration,
                    cfg_weight=request.cfgWeight,
                    temperature=request.temperature,
                )
                voice_conditionals[request.voiceId] = tts.conds
            else:
                wav = tts.generate(
                    request.text,
                    language_id=request.languageId,
                    audio_prompt_path=reference_path,
                    exaggeration=request.exaggeration,
                    cfg_weight=request.cfgWeight,
                    temperature=request.temperature,
                )

            with NamedTemporaryFile(suffix=".wav") as wav_file:
                ta.save(wav_file.name, wav, tts.sr)
                audio = Path(wav_file.name).read_bytes()

        return Response(content=audio, media_type="audio/wav")
    except HTTPException:
        raise
    except Exception as error:
        raise HTTPException(status_code=500, detail=f"Failed to synthesize speech: {error}") from error
    finally:
        if hasattr(reference, "close"):
            reference.close()

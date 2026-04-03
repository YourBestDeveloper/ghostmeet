"""ghostmeet backend — audio capture + chunked STT."""
from __future__ import annotations

import asyncio
import datetime as dt
import logging
import os
import tempfile
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Dict, List

import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from faster_whisper import WhisperModel

from .audio_processor import transcribe_webm_incremental
from .models import Session
from .summarizer import Summary, generate_summary
from .transcriber import Transcriber, Segment

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)

ROOT = Path(__file__).resolve().parent.parent
RECORDINGS_DIR = ROOT / "recordings"
RECORDINGS_DIR.mkdir(parents=True, exist_ok=True)

# config from env
WHISPER_MODEL = os.environ.get("GHOSTMEET_MODEL", "base")
WHISPER_DEVICE = os.environ.get("GHOSTMEET_DEVICE", "auto")
WHISPER_LANGUAGE = os.environ.get("GHOSTMEET_LANGUAGE", None) or None  # empty string → None
CHUNK_INTERVAL = int(os.environ.get("GHOSTMEET_CHUNK_INTERVAL", "300"))

_shared_model: WhisperModel | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _shared_model
    logger.info("Loading whisper model: %s (device=%s)", WHISPER_MODEL, WHISPER_DEVICE)
    loop = asyncio.get_event_loop()
    _shared_model = await loop.run_in_executor(
        None,
        lambda: WhisperModel(WHISPER_MODEL, device=WHISPER_DEVICE, compute_type="float32"),
    )
    logger.info("Whisper model loaded successfully")
    yield


app = FastAPI(title="ghostmeet-backend", version="0.3.0", lifespan=lifespan)

# serve demo page (local only, not committed to git)
_demo_dir = Path(__file__).resolve().parent.parent / "demo"
if _demo_dir.exists():
    from fastapi.staticfiles import StaticFiles
    app.mount("/demo", StaticFiles(directory=str(_demo_dir), html=True), name="demo")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# state
sessions: Dict[str, Session] = {}
transcribers: Dict[str, Transcriber] = {}
summaries: Dict[str, Summary] = {}
transcript_subscribers: Dict[str, List[WebSocket]] = {}


@app.get("/api/health")
def health():
    return {
        "ok": True,
        "service": "ghostmeet-backend",
        "model": WHISPER_MODEL,
        "chunk_interval_sec": CHUNK_INTERVAL,
    }


@app.get("/api/sessions")
def list_sessions():
    return {
        "count": len(sessions),
        "sessions": {k: v.to_dict() for k, v in sessions.items()},
    }


@app.get("/api/sessions/{session_id}")
def get_session(session_id: str):
    if session_id not in sessions:
        raise HTTPException(status_code=404, detail="session not found")
    return sessions[session_id].to_dict()


@app.get("/api/sessions/{session_id}/transcript")
def get_transcript(session_id: str):
    if session_id not in transcribers:
        raise HTTPException(status_code=404, detail="session not found")
    t = transcribers[session_id]
    return {
        "session_id": session_id,
        "segments": t.get_full_transcript(),
        "full_text": t.get_full_text(),
        "segment_count": len(t.transcript),
    }


@app.post("/api/sessions/{session_id}/summarize")
async def summarize_session(session_id: str):
    if session_id not in transcribers:
        raise HTTPException(status_code=404, detail="session not found")
    t = transcribers[session_id]
    text = t.get_full_text()
    if not text.strip():
        raise HTTPException(status_code=400, detail="transcript is empty")
    summary = await generate_summary(text, session_id)
    summaries[session_id] = summary
    return summary.to_dict()


@app.get("/api/sessions/{session_id}/summary")
def get_summary(session_id: str):
    if session_id not in summaries:
        raise HTTPException(status_code=404, detail="summary not found — call POST /summarize first")
    return summaries[session_id].to_dict()


@app.websocket("/ws/transcript/{session_id}")
async def ws_transcript(websocket: WebSocket, session_id: str):
    await websocket.accept()
    transcript_subscribers.setdefault(session_id, []).append(websocket)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    except Exception as exc:
        logger.warning("ws_transcript: connection lost abnormally (%s)", exc)
    finally:
        transcript_subscribers.get(session_id, []).remove(websocket)


async def _broadcast_segments(session_id: str, segments: List[Segment]):
    subs = transcript_subscribers.get(session_id, [])
    data = [s.to_dict() for s in segments]
    dead = []
    for ws in subs:
        try:
            await ws.send_json({"type": "transcript", "segments": data})
        except Exception:
            dead.append(ws)
    for ws in dead:
        subs.remove(ws)


# WebM Cluster element ID — marks the start of actual audio data in the container.
# Everything before the first Cluster is the pure header (EBML + Tracks).
_WEBM_CLUSTER_ID = b'\x1f\x43\xb6\x75'


def _extract_webm_header(first_chunk: bytes) -> bytes:
    """Return the portion of the first webm chunk before the first Cluster element.

    The result (EBML + Segment header + Tracks, no audio data) can be prepended to
    any subsequent cluster bytes to produce a decodable webm file.
    """
    idx = first_chunk.find(_WEBM_CLUSTER_ID)
    if idx < 0:
        logger.warning("Cluster element not found in first webm chunk; cannot extract header")
        return b''
    return first_chunk[:idx]


def _do_transcribe_incremental(chunk_data: bytes, transcriber: Transcriber, time_offset: float) -> list:
    """Synchronous incremental transcription — runs in executor thread.

    chunk_data: complete webm bytes to transcribe (header already embedded).
    time_offset: seconds to add to all returned segment timestamps.
    """
    if not chunk_data:
        return []
    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(suffix='.webm', delete=False) as f:
            f.write(chunk_data)
            tmp_path = f.name
        return transcribe_webm_incremental(tmp_path, transcriber, time_offset)
    except Exception as e:
        logger.error("Incremental transcription failed: %s", e, exc_info=True)
        return []
    finally:
        if tmp_path:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass


@app.websocket("/ws/audio")
async def ws_audio(websocket: WebSocket):
    await websocket.accept()

    session_id = websocket.query_params.get("session")
    if not session_id:
        session_id = dt.datetime.now().strftime("%Y%m%d-%H%M%S")

    out_path = RECORDINGS_DIR / f"{session_id}.webm"

    existing_session = session_id in sessions
    if not existing_session:
        session = Session(
            session_id=session_id,
            file=str(out_path.relative_to(ROOT)),
        )
        sessions[session_id] = session
        transcriber = Transcriber(
            model=_shared_model,
            language=WHISPER_LANGUAGE,
        )
        transcribers[session_id] = transcriber
    else:
        session = sessions[session_id]
        session.status = "streaming"
        transcriber = transcribers[session_id]
        logger.info(
            "Reconnect: reusing session %s (%d segments, %d bytes so far)",
            session_id, len(transcriber.transcript), session.audio_bytes,
        )

    # Per-connection ID: only the most recent connection should mark the session stopped.
    # Uses a plain counter stored as a dynamic attribute (no model change needed).
    session.connection_count = getattr(session, "connection_count", 0) + 1
    my_connection = session.connection_count

    # notify client of session id
    try:
        await websocket.send_json({"session_id": session_id, "reconnected": existing_session})
    except Exception:
        return  # client disconnected before we could respond

    # collect audio — accumulate into one growing file, transcribe periodically
    # Preserve elapsed time across reconnects so the CHUNK_INTERVAL doesn't reset
    now = asyncio.get_event_loop().time()
    chunk_start_time = getattr(session, "chunk_start_time", now)
    session.chunk_start_time = chunk_start_time

    try:
        with out_path.open("ab") as full_file:
            while True:
                message = await websocket.receive()
                if "bytes" in message and message["bytes"]:
                    chunk = message["bytes"]
                    full_file.write(chunk)
                    full_file.flush()
                    session.chunks += 1
                    session.audio_bytes += len(chunk)

                    # Store webm header from the very first chunk (EBML + Tracks, no audio).
                    # Used to prefix incremental chunk files so they are self-contained webm files.
                    if getattr(session, "webm_header_bytes", None) is None:
                        header = _extract_webm_header(chunk)
                        if header:
                            session.webm_header_bytes = header

                    elapsed = asyncio.get_event_loop().time() - chunk_start_time
                    if elapsed >= CHUNK_INTERVAL:
                        last_offset = getattr(session, "last_transcribed_offset", 0)
                        file_size = out_path.stat().st_size
                        chunks_at_trigger = session.chunks  # snapshot before any await
                        with out_path.open("rb") as rf:
                            rf.seek(last_offset)
                            new_bytes = rf.read()
                        header_bytes = getattr(session, "webm_header_bytes", None)
                        if last_offset == 0:
                            chunk_data = new_bytes  # entire file already has EBML header
                        elif header_bytes:
                            chunk_data = header_bytes + new_bytes
                        else:
                            chunk_data = b""
                        time_offset = getattr(session, "last_transcribed_chunk_count", 0) * 1.0
                        logger.info(
                            "Interval reached (%.0fs, %d new bytes, offset=%.1fs), transcribing...",
                            elapsed, len(new_bytes), time_offset,
                        )
                        loop = asyncio.get_event_loop()
                        new_segs = await loop.run_in_executor(
                            None, _do_transcribe_incremental, chunk_data, transcriber, time_offset
                        )
                        if new_segs:
                            session.transcript_segments = len(transcriber.transcript)
                            await _broadcast_segments(session_id, new_segs)
                        session.last_transcribed_offset = file_size
                        session.last_transcribed_chunk_count = chunks_at_trigger
                        chunk_start_time = asyncio.get_event_loop().time()
                        session.chunk_start_time = chunk_start_time

                elif "text" in message and message["text"] == "stop":
                    break
    except WebSocketDisconnect:
        pass
    except Exception as exc:
        logger.warning("ws_audio: connection lost abnormally (%s)", exc)

    # Only the most recent connection should finalize the session.
    # A stale handler (superseded by reconnect) skips cleanup to avoid
    # clobbering session.status and running a concurrent final transcription.
    if session.connection_count != my_connection:
        logger.info(
            "ws_audio: stale handler for session %s (connection %d, current %d) — skipping cleanup",
            session_id, my_connection, session.connection_count,
        )
        return

    # transcribe remaining audio if new data arrived since last transcription
    file_size = out_path.stat().st_size if out_path.exists() else 0
    last_offset = getattr(session, "last_transcribed_offset", 0)
    if file_size > last_offset:
        session.status = "transcribing"
        with out_path.open("rb") as rf:
            rf.seek(last_offset)
            new_bytes = rf.read()
        header_bytes = getattr(session, "webm_header_bytes", None)
        if last_offset == 0:
            chunk_data = new_bytes
        elif header_bytes:
            chunk_data = header_bytes + new_bytes
        else:
            chunk_data = b""
        time_offset = getattr(session, "last_transcribed_chunk_count", 0) * 1.0
        logger.info("Transcribing final audio (%d new bytes, offset=%.1fs)...", len(new_bytes), time_offset)

        loop = asyncio.get_event_loop()
        new_segs = await loop.run_in_executor(
            None, _do_transcribe_incremental, chunk_data, transcriber, time_offset
        )
        if new_segs:
            session.transcript_segments = len(transcriber.transcript)
            await _broadcast_segments(session_id, new_segs)

    session.status = "stopped"
    session.stopped_at = dt.datetime.now().isoformat(timespec="seconds")
    logger.info(
        "Session %s complete: %d chunks, %d bytes, %d segments",
        session_id, session.chunks, session.audio_bytes, session.transcript_segments,
    )


def run() -> None:
    host = os.environ.get("GHOSTMEET_HOST", "0.0.0.0")
    port = int(os.environ.get("GHOSTMEET_PORT", "8877"))
    uvicorn.run(app, host=host, port=port)

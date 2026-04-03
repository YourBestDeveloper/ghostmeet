"""Process incoming webm/opus audio for transcription."""
from __future__ import annotations

import logging
from pathlib import Path

logger = logging.getLogger(__name__)


def transcribe_webm_file(webm_path: str | Path, transcriber) -> list:
    """Transcribe a complete webm file using faster-whisper's native file reader.

    Returns list of new Segment objects.
    """
    from .transcriber import Segment

    path = str(webm_path)
    logger.info("Transcribing file: %s", path)

    segments_gen, info = transcriber.model.transcribe(
        path,
        language=transcriber.language,
        beam_size=5,
        best_of=3,
        vad_filter=True,
        vad_parameters=dict(
            min_silence_duration_ms=1000,
            speech_pad_ms=400,
            threshold=0.3,
        ),
    )

    # force consume the generator — this is where actual inference happens
    raw_segments = list(segments_gen)
    logger.info("Whisper returned %d raw segments", len(raw_segments))

    # skip segments we already have (based on start time)
    last_end = transcriber.transcript[-1].end if transcriber.transcript else 0.0

    new_segments = []
    for seg in raw_segments:
        text = seg.text.strip()
        if not text:
            continue
        # skip segments that overlap with what we already transcribed
        if seg.start < last_end - 0.5:
            continue
        segment = Segment(
            text=text,
            start=seg.start,
            end=seg.end,
        )
        transcriber.transcript.append(segment)
        new_segments.append(segment)
        logger.info("[%.1f-%.1f] %s", segment.start, segment.end, text)

    logger.info("Transcription complete: %d new segments (%d total)", len(new_segments), len(transcriber.transcript))
    return new_segments


def transcribe_webm_incremental(chunk_path: str | Path, transcriber, time_offset: float) -> list:
    """Transcribe a webm chunk that covers only newly added audio.

    chunk_path: temp file containing EBML header (no audio) + new cluster bytes,
                or a complete webm file when time_offset == 0.
    time_offset: seconds to add to all segment timestamps (total duration already transcribed).

    Returns list of new Segment objects.
    """
    from .transcriber import Segment

    path = str(chunk_path)
    logger.info("Transcribing incremental chunk: %s (offset=%.1fs)", path, time_offset)

    segments_gen, _info = transcriber.model.transcribe(
        path,
        language=transcriber.language,
        beam_size=5,
        best_of=3,
        vad_filter=True,
        vad_parameters=dict(
            min_silence_duration_ms=1000,
            speech_pad_ms=400,
            threshold=0.3,
        ),
    )

    raw_segments = list(segments_gen)
    logger.info("Whisper returned %d raw segments (offset=%.1fs)", len(raw_segments), time_offset)

    new_segments = []
    for seg in raw_segments:
        text = seg.text.strip()
        if not text:
            continue
        segment = Segment(
            text=text,
            start=time_offset + seg.start,
            end=time_offset + seg.end,
        )
        transcriber.transcript.append(segment)
        new_segments.append(segment)
        logger.info("[%.1f-%.1f] %s", segment.start, segment.end, text)

    logger.info("Incremental transcription: %d new segments (%d total)", len(new_segments), len(transcriber.transcript))
    return new_segments

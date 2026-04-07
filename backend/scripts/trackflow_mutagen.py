#!/usr/bin/env python3
"""
Read/write TrackFlow audio tags (mutagen).
- Custom Deezer id: ID3 TXXX:TRACKFLOW_ID, Vorbis COMMENT or TRACKFLOW_ID, MP4 freeform.
"""
from __future__ import annotations

import json
import sys
import traceback
from pathlib import Path

TRACKFLOW_DESC = "TRACKFLOW_ID"


def _log_import_error(context: str, exc: BaseException) -> None:
    """Log to stderr so traceback is visible in Node logs; stdout stays a single JSON line from main()."""
    print(f"IMPORT_ERROR [{context}]: {exc!s}", file=sys.stderr, flush=True)
    traceback.print_exc(file=sys.stderr)
    sys.stderr.flush()


def _import_error_result(exc: BaseException) -> dict:
    """Only use mutagen_not_installed when the top-level mutagen package is missing."""
    msg = str(exc)
    name = type(exc).__name__
    mod_name = getattr(exc, "name", "") if isinstance(exc, ModuleNotFoundError) else ""
    missing_mutagen = isinstance(exc, ModuleNotFoundError) and (
        mod_name == "mutagen"
        or msg.rstrip() in ("No module named 'mutagen'", 'No module named "mutagen"')
    )
    err = "mutagen_not_installed" if missing_mutagen else "mutagen_import_failed"
    return {"ok": False, "error": err, "details": f"{name}: {msg}"}


def _safe_str(v) -> str | None:
    if v is None:
        return None
    s = str(v).strip()
    return s if s else None


def read_tags(path: str) -> dict:
    try:
        from mutagen import File
    except Exception as e:
        _log_import_error("read_tags: mutagen.File", e)
        return _import_error_result(e)

    p = Path(path)
    if not p.is_file():
        return {"ok": False, "error": "not_a_file"}

    audio = File(str(p), easy=False)
    if audio is None:
        return {"ok": True, "trackflow_id": None, "artist": None, "title": None, "album": None, "duration_seconds": None}

    duration_seconds = None
    if getattr(audio.info, "length", None) is not None:
        try:
            duration_seconds = int(round(float(audio.info.length)))
        except (TypeError, ValueError):
            pass

    trackflow_id = None
    artist = None
    title = None
    album = None

    # ID3 (MP3)
    if hasattr(audio, "tags") and audio.tags is not None:
        tags = audio.tags
        try:
            frames = list(tags.values())
        except (TypeError, AttributeError):
            frames = [tags[k] for k in tags.keys()] if hasattr(tags, "keys") else []
        for frame in frames:
            fn = type(frame).__name__
            if fn == "TXXX" and getattr(frame, "desc", "").upper() == TRACKFLOW_DESC.upper():
                if frame.text:
                    trackflow_id = _safe_str(frame.text[0])
            elif fn in ("TPE1",):
                if frame.text:
                    artist = _safe_str(frame.text[0])
            elif fn in ("TIT2",):
                if frame.text:
                    title = _safe_str(frame.text[0])
            elif fn in ("TALB",):
                if frame.text:
                    album = _safe_str(frame.text[0])
        if trackflow_id is None and hasattr(tags, "getall"):
            for fr in tags.getall("TXXX"):
                if getattr(fr, "desc", "").upper() == TRACKFLOW_DESC.upper() and fr.text:
                    trackflow_id = _safe_str(fr.text[0])
                    break

    # Vorbis / FLAC / Opus
    if hasattr(audio, "get") and callable(audio.get):
        for key in ("TRACKFLOW_ID", "trackflow_id"):
            v = audio.get(key)
            if v:
                trackflow_id = _safe_str(v[0] if isinstance(v, list) else v)
                break
        if not artist:
            for k in ("ARTIST", "artist"):
                v = audio.get(k)
                if v:
                    artist = _safe_str(v[0] if isinstance(v, list) else v)
                    break
        if not title:
            for k in ("TITLE", "title"):
                v = audio.get(k)
                if v:
                    title = _safe_str(v[0] if isinstance(v, list) else v)
                    break
        if not album:
            for k in ("ALBUM", "album"):
                v = audio.get(k)
                if v:
                    album = _safe_str(v[0] if isinstance(v, list) else v)
                    break

    # MP4 (iTunes freeform ----:com.apple.iTunes:TRACKFLOW_ID)
    if hasattr(audio, "tags") and audio.tags is not None and trackflow_id is None:
        MP4FreeForm = None
        try:
            from mutagen.mp4 import MP4FreeForm as _MP4FreeForm

            MP4FreeForm = _MP4FreeForm
        except Exception as e:
            _log_import_error("read_tags: mutagen.mp4.MP4FreeForm", e)
        if MP4FreeForm:
            ff_key = "----:com.apple.iTunes:TRACKFLOW_ID"
            raw = audio.tags.get(ff_key)
            if raw and len(raw) > 0:
                item = raw[0]
                if isinstance(item, MP4FreeForm):
                    try:
                        data = getattr(item, "data", None) or bytes(item)
                        trackflow_id = _safe_str(data.decode("utf-8"))
                    except Exception:
                        trackflow_id = _safe_str(str(item))
                else:
                    trackflow_id = _safe_str(str(item))
            if trackflow_id is None:
                for k, v in audio.tags.items():
                    if "trackflow" in str(k).lower() and v:
                        trackflow_id = _safe_str(v[0])
                        break

    return {
        "ok": True,
        "trackflow_id": trackflow_id,
        "artist": artist,
        "title": title,
        "album": album,
        "duration_seconds": duration_seconds,
    }


def _flac_vorbis_set(audio, key: str, value: str) -> None:
    """FLAC / Vorbis comments must be lists of strings."""
    audio[key] = [value]


def _norm_vorbis_comment_key(key: str) -> str:
    return "".join(str(key).upper().split()).replace("_", "")


def _flac_vorbis_strip_plex_conflicting_comments(audio) -> None:
    """
    Remove tags that commonly confuse Plex when they disagree with primary ARTIST / ALBUMARTIST:
    MusicBrainz/Picard ids, AcoustID, duplicate artist columns (ARTISTS, *_CREDIT, *SORT), etc.
    TRACKFLOW_ID is preserved here and rewritten afterward.
    """
    for k in list(audio.keys()):
        nk = _norm_vorbis_comment_key(k)
        if nk == "TRACKFLOW_ID":
            continue
        drop = False
        if nk.startswith("MUSICBRAINZ"):
            drop = True
        elif nk.startswith("ACOUSTID"):
            drop = True
        elif nk.startswith("ARTIST") and nk != "ARTIST":
            drop = True
        elif nk.startswith("ALBUMARTIST") and nk != "ALBUMARTIST":
            drop = True
        elif nk.startswith("ALBUM") and nk != "ALBUM":
            drop = True
        elif nk.startswith("TITLE") and nk != "TITLE":
            drop = True
        elif nk == "PERFORMER":
            drop = True
        if not drop:
            continue
        try:
            del audio[k]
        except KeyError:
            pass


def _mp3_strip_plex_conflicting_frames(tags) -> None:
    """Drop MB/AcoustID TXXX and sort frames that can override visible artist/album in Plex."""
    for key in list(tags.keys()):
        fr = tags.get(key)
        if fr is None:
            continue
        fn = type(fr).__name__
        if fn == "TXXX":
            desc = getattr(fr, "desc", "") or ""
            du = desc.upper().replace(" ", "")
            if du == TRACKFLOW_DESC.upper():
                continue
            if du.startswith("MUSICBRAINZ") or "ACOUSTID" in du:
                del tags[key]
    for sort_frame in ("TSOP", "TSOT", "TSOA", "TSO2", "TSOC"):
        try:
            tags.delall(sort_frame)
        except (KeyError, TypeError, ValueError):
            pass


def _mp4_strip_plex_conflicting_atoms(audio) -> None:
    """Remove iTunes sort atoms and MusicBrainz/AcoustID freeform that can skew Plex matching."""
    for sort_k in ("soar", "soaa", "soal", "sonm"):
        try:
            if sort_k in audio:
                del audio[sort_k]
        except (KeyError, TypeError):
            pass
    for k in list(audio.keys()):
        if not isinstance(k, str) or not k.startswith("----:com.apple.iTunes:"):
            continue
        tail = k.rsplit(":", 1)[-1].upper().replace(" ", "")
        if tail.startswith("MUSICBRAINZ") or "ACOUSTID" in tail:
            try:
                del audio[k]
            except KeyError:
                pass


def write_tags(path: str, data: dict) -> dict:
    try:
        from mutagen import File
        from mutagen.id3 import TALB, TIT2, TPE1, TPE2, TXXX
        from mutagen.mp3 import MP3
        from mutagen.id3 import ID3 as MP3_ID3
    except Exception as e:
        _log_import_error("write_tags: mutagen core (File, id3, mp3)", e)
        return _import_error_result(e)

    p = Path(path)
    if not p.is_file():
        return {"ok": False, "error": "not_a_file"}

    deezer_id = _safe_str(data.get("deezer_id") or data.get("trackflow_id"))
    artist = _safe_str(data.get("artist"))
    title = _safe_str(data.get("title"))
    album = _safe_str(data.get("album"))
    album_artist = _safe_str(data.get("album_artist")) or artist

    ext = p.suffix.lower()

    try:
        if ext == ".mp3":
            try:
                audio = MP3(str(p), ID3=MP3_ID3)
            except Exception as e:
                return {"ok": False, "error": f"mp3_open:{e}"}
            if audio.tags is None:
                audio.add_tags()
            tags = audio.tags
            _mp3_strip_plex_conflicting_frames(tags)
            if deezer_id:
                for key in list(tags.keys()):
                    fr = tags.get(key)
                    if fr is None:
                        continue
                    fn = type(fr).__name__
                    if fn == "TXXX" and getattr(fr, "desc", "") == TRACKFLOW_DESC:
                        del tags[key]
                tags.add(TXXX(encoding=3, desc=TRACKFLOW_DESC, text=[deezer_id]))
            if title:
                tags.delall("TIT2")
                tags.add(TIT2(encoding=3, text=title))
            if artist:
                tags.delall("TPE1")
                tags.add(TPE1(encoding=3, text=artist))
            if album_artist:
                tags.delall("TPE2")
                tags.add(TPE2(encoding=3, text=album_artist))
            if album:
                tags.delall("TALB")
                tags.add(TALB(encoding=3, text=album))
            audio.save(v2_version=3)

        elif ext in (".m4a", ".mp4", ".aac"):
            try:
                from mutagen.mp4 import MP4, MP4FreeForm
            except Exception as e:
                _log_import_error("write_tags: mutagen.mp4 (MP4, MP4FreeForm)", e)
                return _import_error_result(e)
            try:
                audio = MP4(str(p))
            except Exception as e:
                return {"ok": False, "error": f"mp4_open:{e}"}
            _mp4_strip_plex_conflicting_atoms(audio)
            if deezer_id:
                key = "----:com.apple.iTunes:TRACKFLOW_ID"
                audio[key] = [
                    MP4FreeForm(deezer_id.encode("utf-8"), dataformat=MP4FreeForm.UTF8),
                ]
            if title:
                audio["\xa9nam"] = [title]
            if artist:
                audio["\xa9ART"] = [artist]
            if album_artist:
                audio["aART"] = [album_artist]
            if album:
                audio["\xa9alb"] = [album]
            audio.save()

        else:
            FLAC = None
            try:
                from mutagen.flac import FLAC as _FLAC

                FLAC = _FLAC
            except Exception as e:
                _log_import_error("write_tags: mutagen.flac.FLAC", e)

            MP4 = None
            try:
                from mutagen.mp4 import MP4 as _MP4

                MP4 = _MP4
            except Exception as e:
                _log_import_error("write_tags: mutagen.mp4.MP4", e)

            OggVorbis = None
            try:
                from mutagen.oggvorbis import OggVorbis as _OggVorbis

                OggVorbis = _OggVorbis
            except Exception as e:
                _log_import_error("write_tags: mutagen.oggvorbis.OggVorbis", e)

            audio = File(str(p), easy=False)
            if audio is None:
                return {"ok": False, "error": "unsupported_format"}

            if FLAC is not None and isinstance(audio, FLAC):
                _flac_vorbis_strip_plex_conflicting_comments(audio)
                if deezer_id:
                    _flac_vorbis_set(audio, "TRACKFLOW_ID", deezer_id)
                if album_artist:
                    _flac_vorbis_set(audio, "ALBUMARTIST", album_artist)
                if artist:
                    _flac_vorbis_set(audio, "ARTIST", artist)
                    _flac_vorbis_set(audio, "PERFORMER", artist)
                if title:
                    _flac_vorbis_set(audio, "TITLE", title)
                if album:
                    _flac_vorbis_set(audio, "ALBUM", album)
                audio.save()

            elif MP4 is not None and isinstance(audio, MP4):
                try:
                    from mutagen.mp4 import MP4FreeForm
                except Exception as e:
                    _log_import_error("write_tags: mutagen.mp4.MP4FreeForm (non-ext branch)", e)
                    return _import_error_result(e)

                _mp4_strip_plex_conflicting_atoms(audio)
                if deezer_id:
                    key = "----:com.apple.iTunes:TRACKFLOW_ID"
                    audio[key] = [
                        MP4FreeForm(deezer_id.encode("utf-8"), dataformat=MP4FreeForm.UTF8),
                    ]
                if title:
                    audio["\xa9nam"] = [title]
                if artist:
                    audio["\xa9ART"] = [artist]
                if album_artist:
                    audio["aART"] = [album_artist]
                if album:
                    audio["\xa9alb"] = [album]
                audio.save()

            elif OggVorbis is not None and isinstance(audio, OggVorbis):
                _flac_vorbis_strip_plex_conflicting_comments(audio)
                if deezer_id:
                    _flac_vorbis_set(audio, "TRACKFLOW_ID", deezer_id)
                if album_artist:
                    _flac_vorbis_set(audio, "ALBUMARTIST", album_artist)
                if artist:
                    _flac_vorbis_set(audio, "ARTIST", artist)
                    _flac_vorbis_set(audio, "PERFORMER", artist)
                if title:
                    _flac_vorbis_set(audio, "TITLE", title)
                if album:
                    _flac_vorbis_set(audio, "ALBUM", album)
                audio.save()

            elif hasattr(audio, "save") and hasattr(audio, "__setitem__"):
                try:
                    if deezer_id:
                        audio["TRACKFLOW_ID"] = deezer_id
                    if artist:
                        audio["ARTIST"] = artist
                    if title:
                        audio["TITLE"] = title
                    if album:
                        audio["ALBUM"] = album
                    audio.save()
                except (KeyError, TypeError, ValueError) as e:
                    return {"ok": False, "error": f"generic_write:{e}"}
            else:
                return {"ok": False, "error": "write_not_supported_for_format"}

    except Exception as e:
        return {"ok": False, "error": f"write_exception:{e}"}

    verify = read_tags(str(p))
    out = {"ok": True, "verify": verify}
    if verify.get("ok") and deezer_id:
        got = _safe_str(verify.get("trackflow_id"))
        if got != deezer_id:
            out["ok"] = False
            out["error"] = f"verify_mismatch:expected={deezer_id!r} got={got!r}"
    return out


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"ok": False, "error": "usage"}))
        sys.exit(1)

    cmd = sys.argv[1]
    if cmd == "read" and len(sys.argv) >= 3:
        out = read_tags(sys.argv[2])
        print(json.dumps(out))
        sys.exit(0 if out.get("ok") else 1)

    if cmd == "write" and len(sys.argv) >= 4:
        path = sys.argv[2]
        arg3 = sys.argv[3]
        try:
            if arg3 == "-":
                raw = sys.stdin.read()
            else:
                raw = arg3
            payload = json.loads(raw)
        except json.JSONDecodeError as e:
            print(json.dumps({"ok": False, "error": f"invalid_json:{e}"}))
            sys.exit(1)
        out = write_tags(path, payload)
        print(json.dumps(out))
        sys.exit(0 if out.get("ok") else 1)

    print(json.dumps({"ok": False, "error": "bad_args"}))
    sys.exit(1)


if __name__ == "__main__":
    main()

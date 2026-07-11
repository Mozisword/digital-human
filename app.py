import os
import json
import asyncio
import uuid
from pathlib import Path

from fastapi import FastAPI, Request, UploadFile, File
from fastapi.responses import StreamingResponse, Response, JSONResponse, FileResponse
from fastapi.staticfiles import StaticFiles
import httpx
import edge_tts

BASE = Path(__file__).resolve().parent
STATIC_DIR = BASE / "static"
UPLOAD_DIR = STATIC_DIR / "uploads"
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
SONG_DIR = BASE / "songs"
SONG_DIR.mkdir(parents=True, exist_ok=True)
PIPER_DIR = BASE / "piper_voices"
PIPER_DIR.mkdir(parents=True, exist_ok=True)
SONG_META = BASE / "songs.json"

# 可选的离线 TTS（piper）。未安装时仅提示，不影响其它功能。
try:
    from piper import PiperVoice
    PIPER_AVAILABLE = True
except Exception:
    PIPER_AVAILABLE = False

# 常用中文 Piper 音色（友好名 -> GitHub release 包名）
PIPER_VOICE_MAP = {
    "zh_CN-huayan-x-low": "voice-zh-cn-huayan-x-low",
    "zh_CN-huayan-medium": "voice-zh_CN-huayan-medium",
}

# Piper 下载状态（后台任务追踪）
PIPER_DOWNLOAD_STATUS = {"downloading": False, "progress": 0, "total": 0, "done": False, "error": ""}

# 自定义音色（语音克隆）：优先 styletts2（纯 Python，兼容 Python 3.13+），
# 其次 coqui-tts / XTTS v2（需 FFmpeg + torchcodec）
import importlib.util
STYLETTS2_AVAILABLE = importlib.util.find_spec("styletts2") is not None
XTTS_AVAILABLE = importlib.util.find_spec("TTS") is not None

# 检测可用克隆引擎
def get_clone_engine():
    if STYLETTS2_AVAILABLE:
        return "styletts2"
    if XTTS_AVAILABLE:
        return "xtts"
    return None

# transformers 5.x 移除了 isin_mps_friendly，coqui-tts 仍需要它 —— 加 monkey-patch
if XTTS_AVAILABLE:
    try:
        import transformers.pytorch_utils as tpu
        if not hasattr(tpu, "isin_mps_friendly"):
            def _isin_mps_friendly(tensor):
                try:
                    import torch
                    dev = tensor.device if hasattr(tensor, "device") else torch.tensor(tensor).device
                    return dev.type == "mps" and torch.backends.mps.is_available()
                except Exception:
                    return False
            tpu.isin_mps_friendly = _isin_mps_friendly
    except Exception:
        pass

VOICE_DIR = BASE / "voices"
VOICE_DIR.mkdir(parents=True, exist_ok=True)
VOICE_META = BASE / "voices.json"

app = FastAPI(title="数字人对话系统")

# ---------- 配置 ----------
DEFAULT_CONFIG = {
    "provider": "ollama",
    "ollama": {"base_url": "http://localhost:11434", "model": "llama3"},
    "openai": {"api_key": "", "base_url": "https://api.openai.com/v1", "model": "gpt-3.5-turbo"},
    "tts": {
        "engine": "edge-tts",                       # edge-tts | piper | custom
        "voice": "zh-CN-XiaoxiaoNeural",            # edge-tts 发音人
        "piper_voice": "",                          # piper 模型本地路径（留空则用默认）
        "custom_voice": "",                         # 当前选用的自定义音色 id
        "enabled": True,
    },
}
CONFIG_PATH = BASE / "config.json"
if CONFIG_PATH.exists():
    try:
        user_cfg = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        for k, v in user_cfg.items():
            if isinstance(v, dict) and isinstance(DEFAULT_CONFIG.get(k), dict):
                DEFAULT_CONFIG[k].update(v)
            else:
                DEFAULT_CONFIG[k] = v
    except Exception:
        pass

def save_config(cfg):
    CONFIG_PATH.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")

# ---------- 配置接口 ----------
@app.get("/api/config")
async def get_config():
    cfg = dict(DEFAULT_CONFIG)
    cfg.setdefault("tts", {})["piper_available"] = PIPER_AVAILABLE
    cfg["tts"]["xtts_available"] = XTTS_AVAILABLE
    cfg["tts"]["styletts2_available"] = STYLETTS2_AVAILABLE
    cfg["tts"]["clone_engine"] = get_clone_engine()
    cfg["tts"]["custom_voices"] = load_voices()
    return JSONResponse(cfg)

@app.post("/api/config")
async def post_config(req: Request):
    cfg = await req.json()
    for k, v in cfg.items():
        if isinstance(v, dict) and isinstance(DEFAULT_CONFIG.get(k), dict):
            DEFAULT_CONFIG[k].update(v)
        else:
            DEFAULT_CONFIG[k] = v
    save_config(DEFAULT_CONFIG)
    return JSONResponse({"ok": True})

# ---------- 列出 Ollama 本地模型 ----------
@app.get("/api/ollama/models")
async def ollama_models(base_url: str = "http://localhost:11434"):
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.get(f"{base_url.rstrip('/')}/api/tags")
            r.raise_for_status()
            data = r.json()
            models = [m["name"] for m in data.get("models", [])]
            return JSONResponse({"models": models})
    except Exception as e:
        return JSONResponse({"error": str(e)})

# ---------- 照片上传 ----------
ALLOWED_IMG = {".png", ".jpg", ".jpeg", ".webp", ".gif"}
ALLOWED_AUDIO = {".mp3", ".wav", ".ogg", ".m4a", ".flac", ".aac"}
ALLOWED_LRC = {".lrc", ".txt"}

@app.post("/api/upload")
async def upload(file: UploadFile = File(...)):
    ext = Path(file.filename).suffix.lower()
    if ext not in ALLOWED_IMG:
        return JSONResponse({"error": "不支持的图片格式"}, status_code=400)
    name = f"{uuid.uuid4().hex}{ext}"
    data = await file.read()
    (UPLOAD_DIR / name).write_bytes(data)
    return JSONResponse({"url": f"/uploads/{name}", "filename": name})

# ---------- 对话（双引擎，流式） ----------
@app.post("/api/chat")
async def chat(req: Request):
    body = await req.json()
    provider = body.get("provider", DEFAULT_CONFIG["provider"])
    messages = body.get("messages", [])

    if provider == "ollama":
        cfg = body.get("ollama", DEFAULT_CONFIG["ollama"])
        base = cfg.get("base_url", "http://localhost:11434").rstrip("/")
        model = cfg.get("model", "llama3")
        payload = {"model": model, "messages": messages, "stream": True}

        async def gen_ollama():
            try:
                async with httpx.AsyncClient(timeout=120) as client:
                    async with client.stream("POST", f"{base}/api/chat", json=payload) as r:
                        if r.status_code != 200:
                            text = await r.aread()
                            yield f"\n[错误] Ollama 返回 HTTP {r.status_code}：{text[:300]}"
                            return
                        async for line in r.aiter_lines():
                            if not line.strip():
                                continue
                            try:
                                data = json.loads(line)
                            except Exception:
                                continue
                            if data.get("error"):
                                yield f"\n[错误] {data['error']}"
                                return
                            delta = data.get("message", {}).get("content", "")
                            if delta:
                                yield delta
            except Exception as e:
                yield f"\n[错误] 无法连接 Ollama（{base}）：{e}"

        return StreamingResponse(gen_ollama(), media_type="text/plain")

    else:
        cfg = body.get("openai", DEFAULT_CONFIG["openai"])
        base = cfg.get("base_url", "https://api.openai.com/v1").rstrip("/")
        model = cfg.get("model", "gpt-3.5-turbo")
        api_key = cfg.get("api_key", "")
        headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
        payload = {"model": model, "messages": messages, "stream": True}

        async def gen_openai():
            try:
                async with httpx.AsyncClient(timeout=120) as client:
                    async with client.stream("POST", f"{base}/chat/completions", json=payload, headers=headers) as r:
                        async for line in r.aiter_lines():
                            if not line or not line.startswith("data:"):
                                continue
                            data = line[len("data:"):].strip()
                            if data == "[DONE]":
                                break
                            try:
                                obj = json.loads(data)
                            except Exception:
                                continue
                            delta = obj.get("choices", [{}])[0].get("delta", {}).get("content", "")
                            if delta:
                                yield delta
            except Exception as e:
                yield f"\n[错误] 无法连接在线 API（{base}）：{e}"

        return StreamingResponse(gen_openai(), media_type="text/plain")

# ---------- TTS 语音合成（edge-tts / 离线 piper） ----------
@app.post("/api/tts")
async def tts(req: Request):
    body = await req.json()
    text = (body.get("text") or "").strip()
    engine = body.get("engine", DEFAULT_CONFIG["tts"].get("engine", "edge-tts"))
    if not text:
        return JSONResponse({"error": "文本为空"}, status_code=400)

    # 离线 piper
    if engine == "piper":
        if not PIPER_AVAILABLE:
            return JSONResponse({"error": "离线 TTS(piper) 未安装，请先 pip install piper-tts"}, status_code=500)
        model_path = DEFAULT_CONFIG["tts"].get("piper_voice") or str(PIPER_DIR / "default.onnx")
        if not Path(model_path).exists():
            return JSONResponse(
                {"error": f"未找到 Piper 模型：{model_path}。请先在设置中下载离线语音。"},
                status_code=500,
            )
        try:
            import io, wave
            cfg_path = Path(model_path).with_suffix(".onnx.json")
            voice = PiperVoice.load(model_path, str(cfg_path) if cfg_path.exists() else None, use_cuda=False)
            buf = io.BytesIO()
            with wave.open(buf, "wb") as wf:
                voice.synthesize_wav(text, wf)
            return Response(buf.getvalue(), media_type="audio/wav")
        except Exception as e:
            msg = str(e)
            if "g2pw" in msg or "No module named" in msg:
                msg = "离线中文语音需要 g2pw（请 pip install g2pw 并重启）。" + msg
            return JSONResponse({"error": f"Piper 合成失败：{msg}"}, status_code=500)

    # 自定义音色（语音克隆）：styletts2（优先） / XTTS v2
    if engine == "custom":
        clone_engine = get_clone_engine()
        if not clone_engine:
            return JSONResponse({"error": "未检测到语音克隆引擎。请运行：pip install styletts2（推荐，纯 Python），或 coqui-tts==0.27.5 librosa torchcodec soundfile（需 FFmpeg）"}, status_code=500)
        vid = body.get("voice") or DEFAULT_CONFIG["tts"].get("custom_voice")
        if not vid:
            return JSONResponse({"error": "未选择自定义音色，请先在设置里上传一个音色样本"}, status_code=400)
        v = next((x for x in load_voices() if x["id"] == vid), None)
        if not v:
            return JSONResponse({"error": "自定义音色不存在或已删除"}, status_code=404)
        wav_path = VOICE_DIR / v["filename"]
        if not wav_path.exists():
            return JSONResponse({"error": "音色音频文件丢失"}, status_code=404)
        lang = (body.get("lang") or v.get("lang") or "zh").lower()

        try:
            import tempfile, os
            if clone_engine == "styletts2":
                from styletts2 import TTS as StyleTTS
                tts = StyleTTS()
                # 下载/加载模型（首次自动下载，~200MB）
                out = tts.inference(text, target_voice=str(wav_path))
                # out 可能是 tensor 或 bytes
                if hasattr(out, "numpy"):
                    import numpy as np, soundfile as sf
                    out_path = tempfile.mktemp(suffix=".wav")
                    sf.write(out_path, out.numpy(), 24000)
                    data = open(out_path, "rb").read()
                    os.remove(out_path)
                    return Response(data, media_type="audio/wav")
                elif isinstance(out, bytes):
                    return Response(out, media_type="audio/wav")
                else:
                    return JSONResponse({"error": f"styletts2 返回了意外类型：{type(out)}"}, status_code=500)
            else:
                # XTTS v2 (coqui-tts)
                lang_map = {"zh": "zh", "zh-cn": "zh", "en": "en", "ja": "ja",
                            "ko": "ko", "fr": "fr", "de": "de", "es": "es", "it": "it",
                            "pt": "pt", "pl": "pl", "tr": "tr", "ru": "ru", "nl": "nl", "cs": "cs", "ar": "ar"}
                xtts_lang = lang_map.get(lang, "zh")
                from TTS.api import TTS as XTTS
                tts = XTTS("tts_models/multilingual/multi-dataset/xtts_v2")
                out_path = tempfile.mktemp(suffix=".wav")
                tts.tts_to_file(text=text, speaker_wav=str(wav_path), language=xtts_lang, file_path=out_path)
                data = open(out_path, "rb").read()
                os.remove(out_path)
                return Response(data, media_type="audio/wav")
        except Exception as e:
            return JSONResponse({"error": f"{clone_engine} 合成失败：{e}"}, status_code=500)

    # 在线 edge-tts
    voice = body.get("voice", DEFAULT_CONFIG["tts"]["voice"])
    try:
        communicate = edge_tts.Communicate(text, voice)
        chunks = []
        async for chunk in communicate.stream():
            if chunk["type"] == "audio":
                chunks.append(chunk["data"])
        audio = b"".join(chunks)
        return Response(content=audio, media_type="audio/mpeg")
    except Exception as e:
        return JSONResponse({"error": f"TTS 生成失败：{e}"}, status_code=500)

# ---------- 离线 Piper 模型下载（首次需联网一次） ----------
@app.get("/api/tts/piper/voices")
async def piper_voices():
    return JSONResponse({"voices": list(PIPER_VOICE_MAP.keys()), "installed": PIPER_AVAILABLE})

@app.post("/api/tts/piper/install")
async def piper_install(req: Request):
    if not PIPER_AVAILABLE:
        return JSONResponse({"error": "请先 pip install piper-tts 并重启服务"}, status_code=500)
    if PIPER_DOWNLOAD_STATUS["downloading"]:
        return JSONResponse({"error": "正在下载中，请稍候…"}, status_code=409)
    body = await req.json()
    key = (body.get("voice") or "zh_CN-huayan-x-low").strip()
    pkg = PIPER_VOICE_MAP.get(key)
    if not pkg:
        return JSONResponse({"error": f"不支持的音色：{key}。可选：{', '.join(PIPER_VOICE_MAP.keys())}"}, status_code=400)

    url = f"https://github.com/rhasspy/piper/releases/download/v0.0.2/{pkg}.tar.gz"
    target_model = PIPER_DIR / "default.onnx"
    target_cfg = PIPER_DIR / "default.onnx.json"

    def _download_and_extract():
        import tarfile, io, urllib.request
        try:
            PIPER_DOWNLOAD_STATUS.update({"downloading": True, "progress": 0, "total": 0,
                                          "done": False, "error": "", "voice": key})
            req_obj = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            r = urllib.request.urlopen(req_obj, timeout=1200)
            total = int(r.headers.get("content-length", 0))
            PIPER_DOWNLOAD_STATUS["total"] = total
            buf = io.BytesIO()
            downloaded = 0
            while True:
                chunk = r.read(65536)
                if not chunk:
                    break
                buf.write(chunk)
                downloaded += len(chunk)
                PIPER_DOWNLOAD_STATUS["progress"] = downloaded
            buf.seek(0)
            tf = tarfile.open(fileobj=buf, mode="r:gz")
            for member in tf.getmembers():
                name = Path(member.name).name
                if name.endswith(".onnx") and not name.endswith(".json"):
                    target_model.write_bytes(tf.extractfile(member).read())
                elif name.endswith(".onnx.json"):
                    target_cfg.write_bytes(tf.extractfile(member).read())
            tf.close()
            if not target_model.exists():
                PIPER_DOWNLOAD_STATUS["error"] = "解压后未找到 .onnx 模型文件"
                return
            DEFAULT_CONFIG["tts"]["piper_voice"] = str(target_model)
            DEFAULT_CONFIG["tts"]["engine"] = "piper"
            save_config(DEFAULT_CONFIG)
            PIPER_DOWNLOAD_STATUS["done"] = True
        except Exception as e:
            PIPER_DOWNLOAD_STATUS["error"] = str(e)
        finally:
            PIPER_DOWNLOAD_STATUS["downloading"] = False

    asyncio.get_event_loop().run_in_executor(None, _download_and_extract)
    return JSONResponse({"ok": True, "message": "下载已开始，请通过 /api/tts/piper/status 查询进度"})

@app.get("/api/tts/piper/status")
async def piper_status():
    return JSONResponse(PIPER_DOWNLOAD_STATUS)

# ================= 自定义音色（语音克隆） =================
def load_voices():
    if VOICE_META.exists():
        try:
            return json.loads(VOICE_META.read_text(encoding="utf-8"))
        except Exception:
            return []
    return []

def save_voices(lst):
    VOICE_META.write_text(json.dumps(lst, ensure_ascii=False, indent=2), encoding="utf-8")

@app.get("/api/tts/voices/custom")
async def list_custom_voices():
    voices = load_voices()
    out = [{"id": v["id"], "name": v.get("name", ""), "duration": v.get("duration"),
            "lang": v.get("lang", "zh")} for v in voices]
    return JSONResponse({"voices": out, "installed": XTTS_AVAILABLE})

@app.post("/api/tts/voices/custom")
async def upload_custom_voice(
    audio: UploadFile = File(...),
    name: str = "",
    lang: str = "zh",
):
    ext = Path(audio.filename).suffix.lower()
    if ext not in ALLOWED_AUDIO:
        return JSONResponse({"error": "不支持的音频格式（支持 mp3/wav/ogg/m4a/flac/aac）"}, status_code=400)
    vid = uuid.uuid4().hex
    raw_path = VOICE_DIR / f"{vid}_raw{ext}"
    raw_path.write_bytes(await audio.read())
    # 转码为 16k 单声道 wav，供 XTTS 使用
    try:
        import librosa, soundfile as sf
        y, sr = librosa.load(str(raw_path), sr=16000, mono=True)
        wav_path = VOICE_DIR / f"{vid}.wav"
        sf.write(str(wav_path), y, 16000)
        dur = len(y) / 16000.0
    except Exception as e:
        return JSONResponse({"error": f"音频转码失败（需安装 librosa/soundfile）：{e}"}, status_code=500)
    try:
        raw_path.unlink()
    except Exception:
        pass
    meta = {
        "id": vid,
        "name": name or Path(audio.filename).stem,
        "filename": f"{vid}.wav",
        "duration": round(dur, 1),
        "lang": (lang or "zh").lower(),
        "addedAt": int(__import__("time").time()),
    }
    voices = load_voices()
    voices.append(meta)
    save_voices(voices)
    return JSONResponse({"ok": True, "voice": meta})

@app.delete("/api/tts/voices/custom/{vid}")
async def delete_custom_voice(vid: str):
    voices = load_voices()
    new = []
    removed = None
    for v in voices:
        if v["id"] == vid:
            removed = v
            p = VOICE_DIR / v["filename"]
            if p.exists():
                try:
                    p.unlink()
                except Exception:
                    pass
        else:
            new.append(v)
    if removed is None:
        return JSONResponse({"error": "音色不存在"}, status_code=404)
    save_voices(new)
    if DEFAULT_CONFIG["tts"].get("custom_voice") == vid:
        DEFAULT_CONFIG["tts"]["custom_voice"] = ""
        save_config(DEFAULT_CONFIG)
    return JSONResponse({"ok": True})

@app.post("/api/tts/xtts/install")
async def xtts_install():
    if not XTTS_AVAILABLE:
        return JSONResponse({"error": "自定义音色引擎未安装。请在项目 venv 中运行：python -m pip install \"coqui-tts==0.27.5\" librosa torchcodec soundfile 并重启服务。"}, status_code=500)
    try:
        from TTS.api import TTS
        tts = TTS("tts_models/multilingual/multi-dataset/xtts_v2")  # 触发模型下载
        return JSONResponse({"ok": True, "model": "xtts_v2"})
    except Exception as e:
        msg = str(e)
        if "torchcodec" in msg or "FFmpeg" in msg:
            msg = ("需要 FFmpeg 系统库。Windows 请安装 FFmpeg full-shared 版本（choco install ffmpeg-full-shared）"
                   "或使用：pip install coqui-tts[codec]")
        return JSONResponse({"error": f"XTTS 模型下载/加载失败：{msg}"}, status_code=500)

# ================= 歌库 =================
def load_songs():
    if SONG_META.exists():
        try:
            return json.loads(SONG_META.read_text(encoding="utf-8"))
        except Exception:
            return []
    return []

def save_songs(lst):
    SONG_META.write_text(json.dumps(lst, ensure_ascii=False, indent=2), encoding="utf-8")

@app.get("/api/songs")
async def list_songs():
    songs = load_songs()
    # 返回精简信息
    out = []
    for s in songs:
        out.append({
            "id": s["id"], "title": s.get("title", "未命名"),
            "artist": s.get("artist", ""), "source": s.get("source"),
            "hasLyrics": bool(s.get("lyricsFile")), "ext": s.get("ext", ""),
        })
    return JSONResponse({"songs": out})

@app.post("/api/songs/upload")
async def upload_song(
    audio: UploadFile = File(...),
    lyrics: UploadFile = File(None),
    title: str = "",
    artist: str = "",
):
    ext = Path(audio.filename).suffix.lower()
    if ext not in ALLOWED_AUDIO:
        return JSONResponse({"error": "不支持的音频格式（支持 mp3/wav/ogg/m4a/flac/aac）"}, status_code=400)
    sid = uuid.uuid4().hex
    audio_path = SONG_DIR / f"{sid}{ext}"
    (audio_path).write_bytes(await audio.read())

    lyrics_file = None
    if lyrics and lyrics.filename:
        lext = Path(lyrics.filename).suffix.lower()
        if lext in ALLOWED_LRC:
            lyrics_file = SONG_DIR / f"{sid}.lrc"
            (lyrics_file).write_bytes(await lyrics.read())

    meta = {
        "id": sid,
        "title": title or Path(audio.filename).stem,
        "artist": artist or "",
        "source": "local",
        "filename": f"{sid}{ext}",
        "ext": ext,
        "lyricsFile": lyrics_file.name if lyrics_file else None,
        "addedAt": int(__import__("time").time()),
    }
    songs = load_songs()
    songs.append(meta)
    save_songs(songs)
    return JSONResponse({"ok": True, "song": meta})

@app.post("/api/songs/online")
async def add_online_song(req: Request):
    body = await req.json()
    url = (body.get("url") or "").strip()
    if not url.startswith("http://") and not url.startswith("https://"):
        return JSONResponse({"error": "请输入合法的 http/https 音频地址"}, status_code=400)
    meta = {
        "id": uuid.uuid4().hex,
        "title": body.get("title") or "在线歌曲",
        "artist": body.get("artist") or "",
        "source": "online",
        "url": url,
        "lyricsFile": None,
        "addedAt": int(__import__("time").time()),
    }
    songs = load_songs()
    songs.append(meta)
    save_songs(songs)
    return JSONResponse({"ok": True, "song": meta})

@app.get("/api/songs/{sid}/audio")
async def song_audio(sid: str, request: Request):
    song = next((s for s in load_songs() if s["id"] == sid), None)
    if not song:
        return JSONResponse({"error": "歌曲不存在"}, status_code=404)

    if song.get("source") == "local":
        path = SONG_DIR / song["filename"]
        if not path.exists():
            return JSONResponse({"error": "音频文件丢失"}, status_code=404)
        return FileResponse(path, media_type="audio/mpeg")

    # 在线：代理转发（支持 Range 以便拖动进度）
    range_hdr = request.headers.get("Range")
    headers = {}
    if range_hdr:
        headers["Range"] = range_hdr
    try:
        async with httpx.AsyncClient(timeout=60, follow_redirects=True) as client:
            r = await client.send(
                client.build_request("GET", song["url"], headers=headers), stream=True
            )
            status = r.status_code
            ct = r.headers.get("content-type", "audio/mpeg")
            cr = r.headers.get("content-range")
            cl = r.headers.get("content-length")

            def gen():
                for chunk in r.iter_bytes(4096):
                    yield chunk

            resp_headers = {"Content-Type": ct, "Accept-Ranges": "bytes"}
            if cr:
                resp_headers["Content-Range"] = cr
            if cl:
                resp_headers["Content-Length"] = cl
            return StreamingResponse(gen(), status_code=status, headers=resp_headers)
    except Exception as e:
        return JSONResponse({"error": f"在线音频获取失败：{e}"}, status_code=502)

@app.get("/api/songs/{sid}/lyrics")
async def song_lyrics(sid: str):
    song = next((s for s in load_songs() if s["id"] == sid), None)
    if not song or not song.get("lyricsFile"):
        return JSONResponse({"lyrics": ""})
    path = SONG_DIR / song["lyricsFile"]
    if not path.exists():
        return JSONResponse({"lyrics": ""})
    return JSONResponse({"lyrics": path.read_text(encoding="utf-8", errors="ignore")})

@app.delete("/api/songs/{sid}")
async def delete_song(sid: str):
    songs = load_songs()
    new = []
    removed = None
    for s in songs:
        if s["id"] == sid:
            removed = s
            if s.get("source") == "local" and s.get("filename"):
                p = SONG_DIR / s["filename"]
                if p.exists():
                    try:
                        p.unlink()
                    except Exception:
                        pass  # 文件删除失败不阻断元数据清理
            if s.get("lyricsFile"):
                p = SONG_DIR / s["lyricsFile"]
                if p.exists():
                    try:
                        p.unlink()
                    except Exception:
                        pass
        else:
            new.append(s)
    if removed is None:
        return JSONResponse({"error": "歌曲不存在"}, status_code=404)
    save_songs(new)
    return JSONResponse({"ok": True})

# ---------- 静态资源 ----------
app.mount("/", StaticFiles(directory=str(STATIC_DIR), html=True), name="static")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)

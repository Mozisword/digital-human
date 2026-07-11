// ============ 数字人对话系统 前端 ============
const $ = (id) => document.getElementById(id);

let cachedSongTitles = [];

async function buildSystemPrompt() {
  let extra = "";
  try {
    if (cachedSongTitles.length === 0) {
      const r = await fetch("/api/songs");
      const d = await r.json();
      cachedSongTitles = (d.songs || []).map(s => s.title).filter(Boolean);
    }
    if (cachedSongTitles.length > 0) {
      extra = " 你还会唱歌，歌库里有这些歌：[" + cachedSongTitles.join("、") + "]。";
      extra += " 如果用户让你唱歌，在回复末尾加一行包含「🎵 唱首歌: 歌名」来让系统自动播放。";
    }
  } catch (_) {}
  return "你是由用户上传照片生成的\"数字人\"助手，请用自然、友好、简洁的中文与用户对话。" + extra;
}

const state = {
  config: null,
  history: [],
  photoUrl: null,
  photoImg: null,
  mouthPos: null,       // 检测到的嘴部位置 {x,y,w,h} 相对图片
  audioCtx: null,
  analyser: null,
  audioData: null,
  speaking: false,
  singing: false,
  mouthOpen: 0,
  songAudio: null,
  customVoices: [],
  // 录音
  recorder: null,
  recChunks: [],
  recording: false,
};

// ---------- 音频图（所有声音经 master -> analyser -> 扬声器；master -> 录制轨道） ----------
let audioGraph = null;
function getGraph() {
  if (audioGraph) return audioGraph;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  analyser.smoothingTimeConstant = 0.6;
  const master = ctx.createGain();
  master.gain.value = 1.0;
  master.connect(analyser);
  analyser.connect(ctx.destination);            // 扬声器
  const recDest = ctx.createMediaStreamDestination(); // 录制用
  master.connect(recDest);
  audioGraph = { ctx, analyser, master, recDest, data: new Uint8Array(analyser.fftSize) };
  state.audioCtx = ctx;
  state.analyser = analyser;
  state.audioData = audioGraph.data;
  return audioGraph;
}
function connectAudioEl(el) {
  const g = getGraph();
  if (el._srcNode) return el._srcNode;
  const src = g.ctx.createMediaElementSource(el);
  src.connect(g.master);
  el._srcNode = src;
  return src;
}

// ---------- 初始化 ----------
async function init() {
  await loadConfig();
  bindUI();
  startAvatarLoop();
  if (state.config.provider === "ollama") refreshOllamaModels();
  addBotMsg("你好！我是你的数字人助手。上传照片、和我聊天，或打开🎵歌库让我为你唱歌～");
}

async function refreshOllamaModels() {
  const base = $("ollamaUrl").value.trim() || "http://localhost:11434";
  try {
    const r = await fetch("/api/ollama/models?base_url=" + encodeURIComponent(base));
    const d = await r.json();
    if (d.error) return;
    const dl = $("ollamaModels");
    dl.innerHTML = d.models.map((m) => `<option value="${m}"></option>`).join("");
    const cur = $("ollamaModel").value.trim();
    if (d.models.length && (!cur || !d.models.includes(cur))) {
      $("ollamaModel").value = d.models[0];
    }
  } catch (e) { /* 忽略 */ }
}

async function loadConfig() {
  try {
    const res = await fetch("/api/config");
    state.config = await res.json();
  } catch (e) {
    state.config = { provider: "ollama", ollama: {}, openai: {}, tts: {} };
  }
  syncSettingsUI();
}

// ---------- 设置面板 ----------
function syncSettingsUI() {
  const c = state.config;
  document.querySelector(`input[name=provider][value="${c.provider || "ollama"}"]`).checked = true;
  $("ollamaUrl").value = c.ollama?.base_url || "";
  $("ollamaModel").value = c.ollama?.model || "";
  $("apiBase").value = c.openai?.base_url || "";
  $("apiKey").value = c.openai?.api_key || "";
  $("apiModel").value = c.openai?.model || "";
  const tts = c.tts || {};
  document.querySelector(`input[name=ttsEngine][value="${tts.engine || "edge-tts"}"]`).checked = true;
  $("ttsVoice").value = tts.voice || "zh-CN-XiaoxiaoNeural";
  $("ttsToggle").checked = tts.enabled !== false;
  toggleEngineBox();
  toggleTtsEngineBox();
  // piper 音色下拉
  fetch("/api/tts/piper/voices").then(r => r.json()).then(d => {
    $("piperVoice").innerHTML = (d.voices || []).map(v => `<option value="${v}">${v}</option>`).join("");
    if (tts.piper_voice) {
      // 已下载则提示
      $("piperStatus").textContent = "✔ 离线模型已就绪，可切换到离线引擎。";
    }
    if (!d.installed) {
      $("piperHint").textContent = "（离线引擎未安装：pip install piper-tts 后重启服务）";
    }
  }).catch(() => {});
  // 自定义音色列表
  loadCustomVoices();
}

async function loadCustomVoices() {
  try {
    const r = await fetch("/api/tts/voices/custom");
    const d = await r.json();
    const voices = d.voices || [];
    state.customVoices = voices;
    const sel = $("customVoice");
    sel.innerHTML = voices.map(v => `<option value="${v.id}">${escapeHtml(v.name)}（${v.duration}s）</option>`).join("");
    const cur = state.config.tts?.custom_voice;
    if (cur && voices.find(v => v.id === cur)) sel.value = cur;
    else if (voices.length) sel.value = voices[0].id;
    // 列表 + 删除
    const list = $("customVoiceList");
    if (!voices.length) {
      list.innerHTML = `<p class="empty">还没有自定义音色，上传一个样本吧～</p>`;
    } else {
      list.innerHTML = voices.map(v => `
        <div class="song-row" data-id="${v.id}">
          <div class="song-meta">
            <div class="song-title">${escapeHtml(v.name)}</div>
            <div class="song-sub">${v.lang === "en" ? "English" : "中文"} · ${v.duration}s</div>
          </div>
          <div class="song-acts">
            <button class="mini use" data-id="${v.id}">✔ 选用</button>
            <button class="mini del" data-id="${v.id}">✕</button>
          </div>
        </div>`).join("");
      list.querySelectorAll("button.use").forEach(b => b.onclick = () => {
        $("customVoice").value = b.dataset.id;
        state.config.tts.custom_voice = b.dataset.id;
        setStatus("已选中音色：" + b.dataset.id);
      });
      list.querySelectorAll("button.del").forEach(b => b.onclick = () => deleteVoice(b.dataset.id));
    }
  } catch (e) { /* 忽略 */ }
}

async function deleteVoice(id) {
  if (!confirm("删除这个自定义音色？")) return;
  await fetch("/api/tts/voices/custom/" + id, { method: "DELETE" });
  if (state.config.tts.custom_voice === id) state.config.tts.custom_voice = "";
  loadCustomVoices();
}

async function uploadVoice() {
  const f = $("voiceFile").files[0];
  if (!f) { setStatus("请先选择音频文件"); return; }
  const fd = new FormData();
  fd.append("audio", f);
  fd.append("name", $("voiceName").value.trim());
  fd.append("lang", $("voiceLang").value);
  setStatus("上传并转码中…");
  try {
    const r = await fetch("/api/tts/voices/custom", { method: "POST", body: fd });
    const d = await r.json();
    if (d.ok) {
      setStatus("音色已上传 ✔ 可切换到“自定义音色”引擎使用");
      $("voiceFile").value = ""; $("voiceName").value = "";
      state.config.tts.custom_voice = d.voice.id;
      $("customVoice").value = d.voice.id;
      loadCustomVoices();
    } else setStatus("上传失败：" + (d.error || ""));
  } catch (e) { setStatus("上传失败：" + e); }
}

async function installXtts() {
  $("xttsStatus").textContent = "下载中…（XTTS 模型约 1.8GB，首次需联网，可能较慢）";
  $("xttsInstallBtn").disabled = true;
  try {
    const r = await fetch("/api/tts/xtts/install", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    });
    const d = await r.json();
    if (d.ok) {
      $("xttsStatus").textContent = "✔ XTTS 模型已就绪，上传音色后即可用克隆音色说话。";
    } else {
      $("xttsStatus").textContent = "✘ " + (d.error || "下载失败");
    }
  } catch (e) {
    $("xttsStatus").textContent = "✘ " + e;
  }
  $("xttsInstallBtn").disabled = false;
}

function toggleEngineBox() {
  const p = document.querySelector("input[name=provider]:checked").value;
  $("ollamaBox").classList.toggle("hidden", p !== "ollama");
  $("openaiBox").classList.toggle("hidden", p !== "openai");
}
function toggleTtsEngineBox() {
  const e = document.querySelector("input[name=ttsEngine]:checked").value;
  $("edgeTtsBox").classList.toggle("hidden", e !== "edge-tts");
  $("piperBox").classList.toggle("hidden", e !== "piper");
  $("customBox").classList.toggle("hidden", e !== "custom");
}

function bindUI() {
  // 顶部
  $("settingsBtn").onclick = () => $("settingsModal").classList.remove("hidden");
  $("closeSettings").onclick = () => $("settingsModal").classList.add("hidden");
  $("songBtn").onclick = openSongModal;
  $("closeSongs").onclick = () => $("songModal").classList.add("hidden");
  $("recordBtn").onclick = toggleRecording;

  document.querySelectorAll("input[name=provider]").forEach(r => r.onchange = () => {
    toggleEngineBox();
    if (document.querySelector("input[name=provider]:checked").value === "ollama") refreshOllamaModels();
  });
  document.querySelectorAll("input[name=ttsEngine]").forEach(r => r.onchange = toggleTtsEngineBox);
  $("fetchModels").onclick = refreshOllamaModels;
  $("piperInstallBtn").onclick = installPiper;

  $("saveSettings").onclick = saveSettings;
  $("sendBtn").onclick = () => sendFromInput();
  $("xttsInstallBtn").onclick = installXtts;
  $("uploadVoiceBtn").onclick = uploadVoice;
  $("input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendFromInput(); }
  });
  $("photoInput").onchange = onPhoto;
  $("micBtn").onclick = toggleVoiceInput;
  $("ttsToggle").onchange = () => { state.config.tts.enabled = $("ttsToggle").checked; };

  // 歌库弹窗
  document.querySelectorAll("#songModal .tab").forEach(t => t.onclick = () => {
    document.querySelectorAll("#songModal .tab").forEach(x => x.classList.remove("active"));
    t.classList.add("active");
    $("tabLib").classList.toggle("hidden", t.dataset.tab !== "lib");
    $("tabAdd").classList.toggle("hidden", t.dataset.tab !== "add");
  });
  $("uploadSongBtn").onclick = uploadSong;
  $("addOnlineBtn").onclick = addOnlineSong;
}

async function saveSettings() {
  const provider = document.querySelector("input[name=provider]:checked").value;
  const engine = document.querySelector("input[name=ttsEngine]:checked").value;
  const cfg = {
    provider,
    ollama: { base_url: $("ollamaUrl").value.trim(), model: $("ollamaModel").value.trim() },
    openai: {
      base_url: $("apiBase").value.trim(),
      api_key: $("apiKey").value.trim(),
      model: $("apiModel").value.trim(),
    },
    tts: {
      engine,
      voice: $("ttsVoice").value.trim() || "zh-CN-XiaoxiaoNeural",
      piper_voice: state.config.tts?.piper_voice || "",
      custom_voice: $("customVoice").value || "",
      enabled: $("ttsToggle").checked,
    },
  };
  state.config = cfg;
  await fetch("/api/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(cfg) });
  $("settingsModal").classList.add("hidden");
  setStatus("设置已保存");
}

async function installPiper() {
  const voice = $("piperVoice").value;
  $("piperStatus").textContent = "正在启动下载…";
  $("piperInstallBtn").disabled = true;
  try {
    const r = await fetch("/api/tts/piper/install", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ voice }),
    });
    const d = await r.json();
    if (!d.ok && d.error) {
      $("piperStatus").textContent = "✘ " + d.error;
      $("piperInstallBtn").disabled = false;
      return;
    }
    // 后台下载中，轮询进度
    $("piperStatus").textContent = "下载中…（GitHub 源，速度较慢请耐心等待）";
    const poll = setInterval(async () => {
      try {
        const sr = await fetch("/api/tts/piper/status");
        const st = await sr.json();
        if (st.done) {
          clearInterval(poll);
          $("piperStatus").textContent = "✔ 下载完成，已切换为离线引擎。";
          $("piperInstallBtn").disabled = false;
          document.querySelector("input[name=ttsEngine][value=piper]").checked = true;
          toggleTtsEngineBox();
          state.config.tts.engine = "piper";
        } else if (st.error) {
          clearInterval(poll);
          $("piperStatus").textContent = "✘ " + st.error;
          $("piperInstallBtn").disabled = false;
        } else if (st.downloading) {
          const pct = st.total > 0 ? Math.round(st.progress / st.total * 100) : 0;
          const mb = (st.progress / 1048576).toFixed(1);
          const totalMb = st.total > 0 ? (st.total / 1048576).toFixed(1) : "?";
          $("piperStatus").textContent = `下载中… ${mb}/${totalMb}MB (${pct}%)`;
        }
      } catch (e) {}
    }, 2000);
  } catch (e) {
    $("piperStatus").textContent = "✘ " + e;
    $("piperInstallBtn").disabled = false;
  }
}

function setStatus(t) { $("status").textContent = t; }

// ---------- 照片 → 数字人 ----------
function onPhoto(e) {
  const file = e.target.files[0];
  if (!file) return;
  const fd = new FormData();
  fd.append("file", file);
  setStatus("上传中…");
  fetch("/api/upload", { method: "POST", body: fd })
    .then((r) => r.json())
    .then((d) => {
      if (d.error) { setStatus(d.error); return; }
      state.photoUrl = d.url;
      state.photoImg = new Image();
      state.photoImg.onload = async () => {
        setStatus("正在检测面部…");
        state.mouthPos = await detectMouth(state.photoImg);
        if (state.mouthPos) {
          setStatus("数字人已生成，口型已对齐 ✔");
        } else {
          setStatus("数字人已生成 ✔");
        }
      };
      state.photoImg.src = d.url;
    })
    .catch((err) => setStatus("上传失败：" + err));
}

// ---------- 对话 ----------
function sendFromInput() {
  const text = $("input").value.trim();
  if (!text) return;
  $("input").value = "";

  // /sing 命令：指挥数字人唱歌
  if (text.startsWith("/sing")) {
    const q = text.slice(5).trim();
    commandSing(q);
    return;
  }
  sendMessage(text);
}

async function sendMessage(text) {
  addUserMsg(text);
  state.history.push({ role: "user", content: text });

  const sp = await buildSystemPrompt();
  const messages = [{ role: "system", content: sp }, ...state.history];
  const provider = document.querySelector("input[name=provider]:checked").value;
  const payload = {
    provider,
    ollama: {
      base_url: $("ollamaUrl").value.trim(),
      model: $("ollamaModel").value.trim(),
    },
    openai: {
      base_url: $("apiBase").value.trim(),
      api_key: $("apiKey").value.trim(),
      model: $("apiModel").value.trim(),
    },
    messages,
  };

  $("sendBtn").disabled = true;
  const bubble = addBotMsg("");
  let full = "";

  try {
    const res = await fetch("/api/chat", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
    });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = dec.decode(value, { stream: true });
      full += chunk;
      bubble.textContent = full;
      scrollBottom();
    }
  } catch (err) {
    full = "[错误] 请求失败：" + err;
    bubble.textContent = full;
    bubble.classList.add("err");
  }

  $("sendBtn").disabled = false;

  if (full.startsWith("[错误]")) {
    bubble.classList.add("err");
  } else {
    // 检测是否要唱歌
    const singMatch = full.match(/🎵\s*唱首歌:\s*(.+)/);
    if (singMatch) {
      const songName = singMatch[1].trim();
      const cleanReply = full.replace(/🎵\s*唱首歌:\s*.+/, "").trim();
      bubble.textContent = cleanReply || ("🎶 唱首《" + songName + "》");
      state.history.push({ role: "assistant", content: cleanReply || full });
      if (state.history.length > 20) state.history = state.history.slice(-20);
      try {
        const r = await fetch("/api/songs");
        const d = await r.json();
        const songs = d.songs || [];
        const hit = songs.find(s => s.title.includes(songName)) || songs.find(s => songName.includes(s.title)) || songs[0];
        if (hit) {
          addBotMsg("🎶 好的，为你演唱《" + hit.title + "》");
          setTimeout(() => singSong(hit.id), 500);
        }
      } catch (_) {}
      return;
    }

    state.history.push({ role: "assistant", content: full });
    if (state.history.length > 20) state.history = state.history.slice(-20);
    if (state.config.tts?.enabled !== false) speak(full);
  }
}

// ---------- 语音输出（TTS + 嘴型） ----------
async function speak(text) {
  setStatus("正在生成语音…");
  const engine = state.config.tts?.engine || "edge-tts";
  const badge = $("speakBadge");
  badge.textContent = "🔊 正在说话…";
  badge.classList.remove("hidden");
  state.speaking = true;
  // 构造 TTS 请求体：不同引擎用不同参数
  const payload = { text, engine };
  if (engine === "custom") {
    payload.voice = state.config.tts?.custom_voice || "";
    const cv = (state.customVoices || []).find(v => v.id === payload.voice);
    payload.lang = (cv && cv.lang) || "zh";
  } else if (engine === "edge-tts") {
    payload.voice = state.config.tts?.voice || "zh-CN-XiaoxiaoNeural";
  } else if (engine === "piper") {
    payload.voice = state.config.tts?.piper_voice || "";
  }
  try {
    const res = await fetch("/api/tts", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      setStatus("语音失败：" + (e.error || res.status));
      state.speaking = false;
      badge.classList.add("hidden");
      return;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    playAudio(url, () => {
      state.speaking = false;
      badge.classList.add("hidden");
      setStatus("就绪");
    });
  } catch (err) {
    setStatus("语音失败：" + err);
    state.speaking = false;
    badge.classList.add("hidden");
  }
}

// 播放一段音频 URL，并接入音频图（用于口型 + 录制）
function playAudio(url, onEnd) {
  const g = getGraph();
  if (g.ctx.state === "suspended") g.ctx.resume();
  const audio = new Audio(url);
  audio.crossOrigin = "anonymous";
  connectAudioEl(audio);
  audio.onended = () => {
    if (onEnd) onEnd();
  };
  audio.play().catch((e) => setStatus("播放失败：" + e));
}

// ---------- 语音输入（STT） ----------
let recognizer = null;
function toggleVoiceInput() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { setStatus("当前浏览器不支持语音输入，请用 Chrome/Edge"); return; }
  if (recognizer && recognizer._active) { recognizer.stop(); return; }

  recognizer = new SR();
  recognizer.lang = "zh-CN";
  recognizer.interimResults = false;
  recognizer._active = true;
  $("micBtn").classList.add("recording");
  setStatus("正在聆听…说完自动发送");

  recognizer.onresult = (e) => {
    const text = e.results[0][0].transcript;
    $("input").value = text;
    sendFromInput();
  };
  recognizer.onerror = (e) => setStatus("语音识别错误：" + e.error);
  recognizer.onend = () => {
    recognizer._active = false;
    $("micBtn").classList.remove("recording");
    if ($("input").value.trim() === "") setStatus("就绪");
  };
  recognizer.start();
}

// ---------- 头像绘制（真实音频振幅驱动嘴型） ----------
function startAvatarLoop() {
  const canvas = $("avatar");
  const ctx = canvas.getContext("2d");
  const W = canvas.width, H = canvas.height;

  function frame() {
    ctx.clearRect(0, 0, W, H);

    // 背景渐变
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, "#eef0ff");
    grad.addColorStop(1, "#dce0f5");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);

    // 说话光环
    const active = state.speaking || state.singing;
    if (active) {
      ctx.save();
      ctx.strokeStyle = "rgba(79,70,229,0.50)";
      ctx.lineWidth = 5;
      // 在图片周围画光晕
      if (state.photoImg) {
        const iw = state.photoImg.width, ih = state.photoImg.height;
        const sx = Math.min(W / iw, H / ih);
        const dw = iw * sx, dh = ih * sx;
        const dx = (W - dw) / 2, dy = (H - dh) / 2;
        ctx.strokeRect(dx - 4, dy - 4, dw + 8, dh + 8);
      } else {
        ctx.strokeRect(4, 4, W - 8, H - 8);
      }
      ctx.restore();
    }

    if (state.photoImg) {
      // 等比居中显示完整照片（不裁剪）
      const iw = state.photoImg.width, ih = state.photoImg.height;
      const scale = Math.min(W / iw, H / ih);
      const dw = iw * scale, dh = ih * scale;
      const dx = (W - dw) / 2, dy = (H - dh) / 2;
      ctx.drawImage(state.photoImg, dx, dy, dw, dh);

      // 嘴型：严格跟随真实音频振幅
      let amp = 0;
      if (state.analyser && (state.speaking || state.singing)) {
        state.analyser.getByteTimeDomainData(state.audioData);
        let sum = 0;
        for (let i = 0; i < state.audioData.length; i++) {
          const x = (state.audioData[i] - 128) / 128;
          sum += x * x;
        }
        amp = Math.sqrt(sum / state.audioData.length);
        amp = Math.min(1, amp * 3.2);
      }
      state.mouthOpen += (amp - state.mouthOpen) * 0.45;
      const open = state.mouthOpen;

      // 在照片的实际嘴部位置画嘴
      if (state.mouthPos) {
        // 检测到的嘴部坐标（相对照片），缩放到 canvas 坐标
        const mx = dx + state.mouthPos.x * scale;
        const my = dy + state.mouthPos.y * scale;
        const mw = state.mouthPos.w * scale * 0.5;
        const mh = 4 + open * state.mouthPos.h * scale * 0.6;

        ctx.fillStyle = "rgba(120, 20, 45, 0.92)";
        ctx.beginPath();
        ctx.ellipse(mx, my, Math.max(4, mw), Math.max(2.5, mh), 0, 0, Math.PI * 2);
        ctx.fill();
        // 高光
        ctx.fillStyle = "rgba(255,255,255,0.2)";
        ctx.beginPath();
        ctx.ellipse(mx, my - mh * 0.25, Math.max(2, mw * 0.5), Math.max(1, mh * 0.35), 0, 0, Math.PI * 2);
        ctx.fill();
      }
    } else {
      // 无照片：占位提示
      ctx.fillStyle = "#9aa3c7";
      ctx.font = "20px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("📷 上传照片", W / 2, H / 2 - 16);
      ctx.fillText("生成数字人", W / 2, H / 2 + 18);
    }

    requestAnimationFrame(frame);
  }
  frame();
}

// 人脸检测：找照片中嘴部位置
async function detectMouth(img) {
  // 默认回退：假设嘴在图片中央偏下区域
  const fallback = { x: img.width / 2, y: img.height * 0.62, w: img.width * 0.2, h: img.height * 0.08 };
  // 尝试使用浏览器内置 FaceDetector API（Chrome/Edge 支持）
  try {
    if (!window.FaceDetector) return fallback;
    const fd = new FaceDetector({ fastMode: true });
    const faces = await fd.detect(img);
    if (!faces || faces.length === 0) return fallback;
    const face = faces[0];
    // 尝试 landmarks
    if (face.landmarks && face.landmarks.length) {
      const mouthLm = face.landmarks.find(l => l.type === "mouth");
      if (mouthLm && mouthLm.locations && mouthLm.locations.length) {
        const pts = mouthLm.locations;
        const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
        const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
        const minX = Math.min(...pts.map(p => p.x));
        const maxX = Math.max(...pts.map(p => p.x));
        const minY = Math.min(...pts.map(p => p.y));
        const maxY = Math.max(...pts.map(p => p.y));
        return {
          x: cx - img.offsetLeft,  // 相对图片
          y: cy - img.offsetTop,
          w: maxX - minX,
          h: maxY - minY,
        };
      }
    }
    // 没有 landmarks：用 face bounding box 估算
    const bb = face.boundingBox;
    return {
      x: bb.left + bb.width * 0.5 - img.offsetLeft,
      y: bb.top + bb.height * 0.78 - img.offsetTop,
      w: bb.width * 0.25,
      h: bb.height * 0.06,
    };
  } catch (e) {
    return fallback;
  }
}

// ================= 歌库 / 唱歌 =================
async function openSongModal() {
  cachedSongTitles = []; // 下次对话时重新拉歌单
  $("songModal").classList.remove("hidden");
  await loadSongList();
}

async function loadSongList() {
  try {
    const r = await fetch("/api/songs");
    const d = await r.json();
    const list = $("songList");
    if (!d.songs || !d.songs.length) {
      list.innerHTML = `<p class="empty">歌库为空，去“上传/添加”里加歌吧～</p>`;
      return;
    }
    list.innerHTML = d.songs.map(s => `
      <div class="song-row" data-id="${s.id}">
        <div class="song-meta">
          <div class="song-title">${escapeHtml(s.title)}</div>
          <div class="song-sub">${escapeHtml(s.artist || "")} · ${s.source === "online" ? "在线" : "本地"}${s.hasLyrics ? " · 含歌词" : ""}</div>
        </div>
        <div class="song-acts">
          <button class="mini sing" data-id="${s.id}">▶ 让数字人唱</button>
          ${s.hasLyrics ? `<button class="mini lrc" data-id="${s.id}">📜 词</button>` : ""}
          <button class="mini del" data-id="${s.id}">✕</button>
        </div>
      </div>`).join("");
    list.querySelectorAll("button.sing").forEach(b => b.onclick = () => singSong(b.dataset.id));
    list.querySelectorAll("button.lrc").forEach(b => b.onclick = () => toggleLyrics(b.dataset.id));
    list.querySelectorAll("button.del").forEach(b => b.onclick = () => deleteSong(b.dataset.id));
  } catch (e) {
    $("songList").innerHTML = `<p class="empty">加载失败：${e}</p>`;
  }
}

async function uploadSong() {
  const f = $("songFile").files[0];
  if (!f) { setStatus("请先选择音频文件"); return; }
  const fd = new FormData();
  fd.append("audio", f);
  const lf = $("lyricsFile").files[0];
  if (lf) fd.append("lyrics", lf);
  fd.append("title", $("songTitle").value.trim());
  fd.append("artist", $("songArtist").value.trim());
  setStatus("上传中…");
  try {
    const r = await fetch("/api/songs/upload", { method: "POST", body: fd });
    const d = await r.json();
    if (d.ok) {
      setStatus("已加入歌库 ✔");
      $("songFile").value = ""; $("lyricsFile").value = "";
      $("songTitle").value = ""; $("songArtist").value = "";
      loadSongList();
    } else setStatus("上传失败：" + (d.error || ""));
  } catch (e) { setStatus("上传失败：" + e); }
}

async function addOnlineSong() {
  const title = $("onlineTitle").value.trim();
  const url = $("onlineUrl").value.trim();
  if (!url) { setStatus("请填写音频 URL"); return; }
  try {
    const r = await fetch("/api/songs/online", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, artist: "", url }),
    });
    const d = await r.json();
    if (d.ok) {
      setStatus("在线歌曲已添加 ✔");
      $("onlineTitle").value = ""; $("onlineUrl").value = "";
      loadSongList();
    } else setStatus("添加失败：" + (d.error || ""));
  } catch (e) { setStatus("添加失败：" + e); }
}

async function deleteSong(id) {
  if (!confirm("确定删除这首歌？")) return;
  await fetch("/api/songs/" + id, { method: "DELETE" });
  loadSongList();
}

// 让数字人唱歌：播放音频（口型自动跟随），并加载歌词
async function singSong(id) {
  $("songModal").classList.add("hidden");
  const g = getGraph();
  if (g.ctx.state === "suspended") g.ctx.resume();
  if (!state.songAudio) {
    state.songAudio = new Audio();
    state.songAudio.crossOrigin = "anonymous";
    connectAudioEl(state.songAudio);
    state.songAudio.onended = () => {
      state.singing = false;
      $("speakBadge").classList.add("hidden");
      $("lyricsBox").classList.add("hidden");
      setStatus("就绪");
    };
  }
  const audioUrl = "/api/songs/" + id + "/audio";
  state.songAudio.src = audioUrl;
  const badge = $("speakBadge");
  badge.textContent = "🎤 唱歌中…";
  badge.classList.remove("hidden");
  state.singing = true;
  setStatus("数字人正在唱歌 🎶");
  state.songAudio.play().catch(e => setStatus("播放失败：" + e));

  // 歌词
  try {
    const r = await fetch("/api/songs/" + id + "/lyrics");
    const d = await r.json();
    if (d.lyrics && d.lyrics.trim()) {
      state.lyrics = parseLRC(d.lyrics);
      state.songAudio.ontimeupdate = syncLyrics;
      showLyrics();
    } else {
      state.lyrics = null;
      $("lyricsBox").classList.add("hidden");
    }
  } catch (e) { state.lyrics = null; }
}

// /sing 文本命令
async function commandSing(query) {
  if (!query) { addBotMsg("用法：/sing 歌名"); return; }
  try {
    const r = await fetch("/api/songs");
    const d = await r.json();
    const songs = d.songs || [];
    const hit = songs.find(s => s.title.includes(query)) || songs.find(s => query.includes(s.title)) || songs[0];
    if (!hit) { addBotMsg("歌库里还没有歌，先打开🎵歌库添加吧～"); return; }
    addBotMsg("🎶 好的，为你演唱《" + hit.title + "》");
    singSong(hit.id);
  } catch (e) { addBotMsg("查找歌曲失败：" + e); }
}

// LRC 解析
function parseLRC(text) {
  const lines = [];
  const re = /\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
  text.split(/\r?\n/).forEach(line => {
    const m = line.match(re);
    if (!m) return;
    const content = line.replace(re, "").trim();
    if (!content) return;
    m.forEach(tag => {
      const mm = tag.match(/\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/);
      const t = parseInt(mm[1]) * 60 + parseInt(mm[2]) + (mm[3] ? parseInt(mm[3]) / 100 : 0);
      lines.push({ t, text: content });
    });
  });
  lines.sort((a, b) => a.t - b.t);
  return lines;
}
function syncLyrics() {
  if (!state.lyrics || !state.songAudio) return;
  const t = state.songAudio.currentTime;
  let cur = null;
  for (const l of state.lyrics) {
    if (l.t <= t) cur = l.text; else break;
  }
  const box = $("lyricsBox");
  if (cur) {
    if (box.dataset.cur !== cur) {
      box.dataset.cur = cur;
      box.textContent = cur;
    }
  }
}
function showLyrics() {
  const box = $("lyricsBox");
  box.classList.remove("hidden");
  box.textContent = "♪ …";
  box.dataset.cur = "";
}

// ================= 视频录制 =================
function pickMime() {
  const cands = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm", "video/mp4"];
  for (const c of cands) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(c)) return c;
  }
  return "";
}
function toggleRecording() {
  if (!state.recording) startRecording();
  else stopRecording();
}
function startRecording() {
  const g = getGraph();
  if (g.ctx.state === "suspended") g.ctx.resume();
  const canvas = $("avatar");
  const vStream = canvas.captureStream(30);
  const aStream = g.recDest.stream;
  const tracks = [...vStream.getVideoTracks(), ...aStream.getAudioTracks()];
  const combined = new MediaStream(tracks);
  const mime = pickMime();
  try {
    state.recorder = new MediaRecorder(combined, mime ? { mimeType: mime } : undefined);
  } catch (e) {
    setStatus("当前浏览器不支持录制：" + e);
    return;
  }
  state.recChunks = [];
  state.recorder.ondataavailable = (e) => { if (e.data && e.data.size) state.recChunks.push(e.data); };
  state.recorder.onstop = () => {
    const blob = new Blob(state.recChunks, { type: mime || "video/webm" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "数字人_" + Date.now() + ".webm";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    setStatus("视频已下载 ✔（" + Math.round(blob.size / 1024) + "KB）");
  };
  state.recorder.start();
  state.recording = true;
  $("recBadge").classList.remove("hidden");
  $("recordBtn").textContent = "⏹ 停止录制";
  setStatus("● 录制中…播放语音或歌曲即可录入口型动画");
}
function stopRecording() {
  if (state.recorder && state.recorder.state !== "inactive") state.recorder.stop();
  state.recording = false;
  $("recBadge").classList.add("hidden");
  $("recordBtn").textContent = "🎬 录制视频";
}

// ---------- 工具 ----------
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function addUserMsg(t) {
  const d = document.createElement("div");
  d.className = "msg user"; d.textContent = t;
  $("messages").appendChild(d); scrollBottom();
}
function addBotMsg(t) {
  const d = document.createElement("div");
  d.className = "msg bot"; d.textContent = t;
  $("messages").appendChild(d); scrollBottom();
  return d;
}
function scrollBottom() { const m = $("messages"); m.scrollTop = m.scrollHeight; }

init();

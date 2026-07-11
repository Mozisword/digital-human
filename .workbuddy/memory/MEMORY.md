# 数字人对话系统 - 项目记忆

## 项目位置
`E:\nice\shuziren\`

## 技术栈
- 后端：FastAPI + uvicorn（Python 3.13 venv）
- 前端：原生 HTML/CSS/JS（Canvas 头像动画 + Web Audio 口型同步）
- LLM：Ollama（本地）/ OpenAI 兼容 API（在线），流式对话
- TTS：edge-tts（在线）/ Piper（离线）/ TTS==0.22.0 XTTS v2（自定义音色克隆）
- venv 路径：`C:\Users\OMEN\.workbuddy\python\envs\shuziren`

## 关键约定
- **.bat 文件**：必须用 `chr(92)` + `wb` 模式写，纯 ASCII，绝不用 Write 工具或 heredoc 传反斜杠（Git Bash 会吞掉）。
- **TTS 包**：用 `TTS==0.22.0`，不用 `coqui-tts`（0.27.x 有依赖冲突 bug）。需 `numpy<2`。
- **pip install**：永远用 venv 的 python.exe（3.13），不用系统 Python 3.14。
- **start.bat**：启动时自动检测 TTS 是否已装，未装则打印安装命令。

## 已知限制
- Piper 离线中文模型和 XTTS v2 模型都需从 HuggingFace 下载，沙箱环境屏蔽 HF 无法验证。
- 语音输入依赖 Chrome/Edge Web Speech API。
- 视频导出为 webm 格式（纯客户端 MediaRecorder）。

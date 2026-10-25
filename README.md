# 蔚来车载智能交互 Agent

本项目是一个本地运行的蔚来座舱助手演示，包含 HMI 页面和 Agent Runtime。语音或文字指令经本地 Vehicle-SLU 模型解析成结构化语义，再交给 Safety Gateway 做安全裁决和二次确认，最后由模拟车辆执行，并同步驱动 ES7 3D 车模动画。项目还集成了用户手册 RAG、天气查询、本地语音唤醒与 TTS 播报。

## 主要能力

- **语义边界**：每轮对话只向本地 Ollama 模型（`cockpit-slu-v11-round4`）发一次 Vehicle-SLU 请求；输出结构不合法时直接拒绝，不执行任何动作。
- **安全**：车辆写操作必须经 Safety Gateway；高风险动作需要用户在确认弹窗里二次确认。
- **车辆执行**：模拟车辆 Provider，覆盖车窗、尾门、座椅、空调、组件等能力，并联动 ES7 3D 舞台。
- **知识与外部数据**：ES8 用户手册 RAG（带证据页码）、天气查询。
- **语音**：本地 KWS 唤醒、GPT-SoVITS TTS（不可用时退回浏览器语音），以及默认关闭的主驾声纹确认实验功能。

## 运行

依赖：Node.js、Ollama（需要本地 Vehicle-SLU 模型 `cockpit-slu-v11-round4:latest`、`qwen3:8b`、`bge-m3`）；GPT-SoVITS 为可选。模型权重不随仓库分发。

```bash
npm start
```

启动后打开 `http://127.0.0.1:4173/`。服务端点、环境变量和云端模型（DashScope，可选）的说明见 [PROJECT_GUIDE.md](PROJECT_GUIDE.md)。

## 测试

```bash
npm run verify:offline
```

需要运行中服务的测试分组：`npm run verify:online`、`npm run verify:hmi`。

## 文档

- [PROJECT_GUIDE.md](PROJECT_GUIDE.md)：项目导航、当前能力与验收标准
- [docs/specs/](docs/specs/)：现行架构、安全、车辆执行与演示规范
- [docs/guides/](docs/guides/)：设计与配置指南

## 说明

- ES8 用户手册 PDF 属于蔚来版权材料，未随仓库分发；手册 RAG 使用已切分的索引运行，只是不提供 PDF 下载。
- ES7 车模派生自 ItsDiyor 的「Nio ES7 2023」（CC BY 4.0），署名见 [vehicle-model-lab/THIRD_PARTY_NOTICES.md](vehicle-model-lab/THIRD_PARTY_NOTICES.md)。
- 这是个人非商业演示项目，与蔚来官方无关。

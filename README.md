# 演出总控播出程序 (Show Control)

小型现场演出的总控/播出系统。接入 **两路实时摄像机信号 + 一路测试图源**，把不同帧率、分辨率和音频采样率的输入同步到统一的节目输出规格，操作员先预监、再切换，切换以输出媒体时间为准。

- 输入：CAM 1 `640x360@25 / 44.1kHz`、CAM 2 `1280x720@30 / 48kHz`、TEST `960x540@24 / 32kHz`
- 输出：`1280x720@25`、48kHz 立体声，H.264 + AAC
- 每路输入是**独立进程、独立时钟**，内部 PTS 单调递增
- 节目时钟由内核驱动：帧号与音频样本计数持续前进，**输入重建不会重置节目时钟**
- 真实媒体输出：HLS 直播、MPEG-TS 归档、节目 MP3、节目 MJPEG 监听

## 启动界面（重要）

界面不是静态页面，它由总控内核驱动：按钮通过 WebSocket 下发命令，所有显示值都来自内核状态回传；内核拒绝切换时会写回失败原因并记入切换历史。

```bash
cd /workspace
npm install          # 已安装可跳过
npm start            # 启动内核 + 三路信号源 + 编码器 + 控制页
```

然后在浏览器打开：

```
http://127.0.0.1:8080/
```

启动后终端会打印控制页、HLS、归档、监听地址和每路源的规格。停止用 `Ctrl-C`。

需要 Node 22+。ffmpeg 默认使用 `node_modules/ffmpeg-static/ffmpeg`，可用 `FFMPEG=/path/to/ffmpeg` 覆盖。

## 操作流程

1. **预监**：点击信号源卡片缩略图或「预监」按钮。左上 `PVW` 监视器显示该路画面，同时显示该路锁定状态、缓冲深度和原生规格。
2. **切换**：按 TAKE（或直接点源卡片上的 `TAKE`，也会先预监再切）。切换请求进入内核队列，在下一个节目帧边界生效。
3. **核对**：顶部 `PROGRAM TIMECODE`、`FRAME`、样本计数持续前进；右侧「切换记录」列出实际生效的切换，包含时间码、节目帧、样本位置、来源、目标、延迟。
4. **看声音**：输出面板的 `PROGRAM AUDIO` 播放真实节目声音（编码器 MP3 监听）。点击「开启声音」即可听。切换后音调应立刻换到新源的音调（440 / 660 / 880 Hz）。
5. **验证异常**：点击某路「停顿」模拟信号源落后，观察该路补帧/静音计数与「同步决策」日志；点「重建」重建输入，节目时钟不重置、帧号不跳变。

界面上的 `补帧 / 丢帧 / 静音` 都来自内核计数器，而不是前端估算。

## 架构

```
                 ┌──────────────── 每个源一个进程 ────────────────┐
 tcp ──> ffmpeg ─┤ raw YUV + framecrc PTS   → SyncSource        │
 (独立时钟)      │ 重采样 PCM + framecrc     → 音频游标           │
                 └───────────────────────────────────────────────┘
                                   │ 以节目时间 T 采样
                                   ▼
    ProgramClock ──> 选择源帧 ──> 合成条/彩条(Canvas 渲染) ──> 单一 ffmpeg 编码器
    帧/样本永续前进                │                              ├─ HLS 直播
                                   ▼                              ├─ MPEG-TS 归档
                              音频重采样拉取                       ├─ 节目 MJPEG 监听
                                                                  └─ 节目 MP3 监听
```

关键模块：

| 文件 | 职责 |
| --- | --- |
| `src/sync_source.js` | 每路源的帧同步器：锚点 `requiredPts(T)=anchorSrcPts+(T-anchorProgram)`、补帧、丢帧、音频游标、静音、缓冲上限 |
| `src/source_ingest.js` | 单路输入解复用：原始 YUV + framecrc 时间戳、重采样 PCM、预览 MJPEG/MP3 |
| `src/source_simulator.js` | 信号源生成：Node/Canvas 逐帧渲染计数器画面（帧号/时间码/音调），独立帧率与采样率，可注入 PPM 时钟漂移 |
| `src/engine.js` | 总控内核：节目时钟、切换仲裁、决策日志、状态快照 |
| `src/compositor.js` | 节目画面合成（源画面 + 底部总控信息条） |
| `src/program_encoder.js` | 单编码器扇出：tee(HLS+TS) + MJPEG + MP3 |
| `src/server.js` | HTTP + WebSocket：命令通道、状态广播、MJPEG/MP3/HLS 端点 |
| `public/` | 操作台界面 |

### 同步机制（为什么不是「取最新帧」）

节目时间 `T` 是唯一权威。每路源建立连接时记录锚点：第一条帧的源 PTS 对应「当前节目时间 + 目标延迟」。之后每一帧都按

```
requiredPts(T) = anchorSrcPts + (T − anchorProgram)
```

在该源自己的时间轴上查找**不晚于 requiredPts 的最新帧**。因此：

- 源跑得慢/停顿 → 没有新帧可用 → **重复上一帧（补帧）**，音频对应区间**静音**；
- 源跑得快 → 领先超过上限 → **重基准并丢帧**；
- 缓冲有上限：视频超限重基准，音频只保留 1.5s 滚动窗口，更旧的块计入 `audioTrimmed`；
- 输入重建只重建锚点与队列，节目时钟、帧号、样本计数完全不动，`lastShown` 保留以免闪现黑场。

音频侧按采样游标精确拉取每帧所需的 1920 个立体声样本（48kHz / 25fps），不足处补零并计入静音样本数。

## 验证

```bash
npm test             # 帧同步器单元测试（稳态/停顿/快源/慢源/时间码/帧解析）
npm start            # 另开一个终端保持运行
npm run verify       # 端到端：连续切换 + 音画对应 + 输出可解码
```

`npm run verify` 会依次切到三路源，并：

1. 断言切换过程中帧号与样本计数单调前进、样本数始终为帧号 × 1920；
2. 抓取**实际节目输出音频**，用 Goertzel 测量主频，确认与当前播出源的音调一致（440/660/880Hz）；
3. 下载 TS 归档与 HLS 分片，用 ffmpeg 解码，确认无解码错误、帧数充足。

## 交付端点

| 端点 | 内容 |
| --- | --- |
| `GET /` | 操作台控制页 |
| `GET /hls/index.m3u8` | 节目 HLS 直播（1s 分片，8 个列表项） |
| `GET /archive/program.ts` | 节目 MPEG-TS 归档 |
| `GET /stream/program.mjpg` | 节目输出 MJPEG 监听 |
| `GET /stream/preview.mjpg` | 预监 MJPEG |
| `GET /stream/source/<id>.mjpg` | 单路源监听 |
| `GET /audio/program.mp3` | 节目输出声音 |
| `GET /api/state` | 内核完整状态（节目、各路同步快照、切换与决策日志） |
| `GET /api/health` | 运行时间与编码器快照 |
| `WS /ws` | 命令 / 状态 / 二进制画面通道 |

## 可调参数（环境变量）

`HTTP_PORT`(8080)、`HOST`(127.0.0.1)、`OUT_FPS`、`OUT_WIDTH`/`OUT_HEIGHT`、`OUT_SAMPLE_RATE`、`TARGET_LATENCY_MS`(320)、`MAX_VIDEO_BUFFER_MS`(1200)、`MAX_AUDIO_BUFFER_MS`(1500)、`LOCK_SPAN_MS`(700)、`TAKE_TIMEOUT_MS`(6000)、`PPM_CAM1`/`PPM_CAM2`/`PPM_TEST`（源时钟漂移，单位 ppm）、`START_SOURCES`(true)。

## 已知限制

- 本仓库附带的 `ffmpeg-static` 构建没有 `drawtext`，因此信号源计数器画面由 `@napi-rs/canvas` 在 Node 内逐帧渲染，不依赖 ffmpeg 文字滤镜。
- 实时归档是边写边服务的，读取时末尾可能包含尚在写入的半个 GOP；`npm run verify` 按节目时间扣除最后 2 秒再解码。HLS 分片是完整写入后才出现在清单里的，可直接解码。
- 界面依赖浏览器支持 HLS（hls.js 已内置）；不支持时会回退到服务端编码器的 MJPEG 节目监听画面。
- 本环境缺少 Chromium 运行库，界面只做了接口/静态一致性检查与浏览器无害降级，未能在真实浏览器中自动点击验证。

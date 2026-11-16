# 演出总控播出程序 (Show Control)

小型现场演出的总控/播出系统。接入 **两路实时摄像机信号 + 一路测试图源**，把不同帧率、分辨率和音频采样率的输入同步到统一的节目输出规格，操作员先预监、再切换，切换以输出媒体时间为准。

- 输入：CAM 1 `640x360@25 / 44.1kHz`、CAM 2 `1280x720@30 / 48kHz`、TEST `960x540@24 / 32kHz`
- 输出：`1280x720@25`、48kHz 立体声，H.264 + AAC
- 每路输入是**独立进程、独立时钟**，内部 PTS 单调递增
- 节目时钟由内核驱动：帧号与音频样本计数持续前进，**输入重建不会重置节目时钟**
- 真实媒体输出：HLS 直播、MPEG-TS 归档、节目 MP3、节目 MJPEG 监听

## 启动界面（重要）

界面不是静态页面，它由总控内核驱动：按钮通过 WebSocket 下发命令，所有显示值都来自内核状态回传；内核拒绝切换时会写回失败原因并记入切换历史。

**演出总控图形入口：[http://127.0.0.1:8080/](http://127.0.0.1:8080/)**。点信号源卡片进入预监（PVW），按 TAKE 切入节目（PGM），在页面上核对节目画面、节目声音与各路音频电平。

命令行只用于辅助启动与自动校验（`npm start` / `npm test` / `npm run verify` / `node test/ui_click_check.js`），实际操作以该图形入口为准。

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

需要 Node 22+。ffmpeg 默认使用 `node_modules/ffmpeg-static/ffmpeg`，可用 `FFMPEG=/path/to/ffmpeg` 覆盖。启动时会**探测实际二进制**并在终端打印 `Media decoder`；低于支持的主版本会直接拒绝启动，而不是退化运行。

## 媒体依赖（已在构建中锁定）

`ffmpeg-static` 固定为 **5.3.0**（`package.json` 精确版本，非 `^`），其随包二进制为 **FFmpeg 7.0.2**。本机实际探测结果写入 `/api/state` 的 `decode.dependency`：

| 字段 | 值 |
| --- | --- |
| `version` | `7.0.2` |
| `status` | `validated`（在已验证目标上）/ `untested`（可用但不在已验证清单）/ `incompatible`（拒绝启动） |
| `validatedAgainst` | `ffmpeg-static@b6.1.1 (FFmpeg 7.0.x)` |
| `staticMismatch` | 包内 `ffmpeg.README` 声明版本与二进制不符时给出提示（不静默） |

FFmpeg 主版本低于 5 会以 `MEDIA_DEP_INCOMPATIBLE` 拒绝启动。解码所需的 `-fps_mode`、`-flush_packets` 等在探测阶段一并验证。

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
| `src/decode_adapter.js` | **版本化解码契约**：显式解码计划、字段校验、旧配置转换、ffmpeg 参数生成、契约证据 |
| `src/source_ingest.js` | 单路输入解复用：按契约取原始 YUV + framecrc 时间戳、定长 PCM 块、预览 MJPEG/MP3、EOF 排空 |
| `src/media_runtime.js` | 实际 ffmpeg 二进制探测与验证（版本、能力、包声明一致性） |
| `src/audio_meter.js` | 从送编码器的真实 s16le 样本计算 RMS/峰值 dBFS 与健康状态 |
| `src/framecrc.js` | framecrc 解析：有理时间基、末行补齐、错误上报 |
| `src/sync_source.js` | 每路源的帧同步器：锚点 `requiredPts(T)=anchorSrcPts+(T-anchorProgram)`、补帧、丢帧、音频游标、静音、缓冲上限 |
| `src/source_simulator.js` | 信号源生成：Node/Canvas 逐帧渲染计数器画面（帧号/时间码/音调），独立帧率与采样率，可注入 PPM 时钟漂移 |
| `src/engine.js` | 总控内核：节目时钟、切换仲裁、决策日志、状态快照、解码计划与音频计量 |
| `src/compositor.js` | 节目画面合成（源画面 + 底部总控信息条） |
| `src/program_encoder.js` | 单编码器扇出：tee(HLS+TS) + MJPEG + MP3 |
| `src/server.js` | HTTP + WebSocket：命令通道、状态广播、MJPEG/MP3/HLS 端点 |
| `public/` | 操作台界面 |

### 版本化解码接口（解码适配迁移 1.0.0 → 2.0.0）

所有异构输入都通过同一个版本化接口接入，不再各自拼装 ffmpeg 命令。

**契约版本**：
- `2.0.0` — 显式解码计划。每个字段必填，缺字段报 `DECODE_FIELD_MISSING`，未知版本报 `DECODE_VERSION_UNSUPPORTED`，无法判定契约报 `DECODE_CONTRACT_MISSING`。**不以默认值补全**。
- `1.0.0` — 旧节目配置。由 `migrateLegacyProgramConfig` 转换为 2.0.0 计划，并在计划 `legacy.from` 中标注来源、在 `legacy.assumed` 中逐条列出所有隐含取值（如 `video.pixelFormat=yuv420p`），迁移不隐藏任何假设。

`DECODE_ADAPTER_VERSION=1.0.0` 可让内核以旧配置形态启动，但走的是同一条迁移路径：节目输出连续，状态中每路计划的 `legacyFrom` 为 `1.0.0`。

**计划声明的语义**（可在 `/api/state` 的 `decode.plans` 逐源查看）：

| 字段 | 取值 | 说明 |
| --- | --- | --- |
| `pixelFormat` | `yuv420p` | 解码后像素格式，显式 `format=yuv420p` 滤镜，不依赖解码器默认 |
| `fpsMode` | `passthrough` | 不按输出帧率重采样源帧；切换器的帧同步按源时间戳进行 |
| `videoTimeBase` | 如 `1/25`、`1/24`、`1/30` | 有理时间基（非仅比值），按源实际交付的时间基换算 |
| `audioTimeBase` | `1/48000` | 与视频同为有理形式 |
| `audioSampleRate` / `audioBlockSamples` | `48000` / `960` | 每块 960 样本（40ms 立体声） |
| `audioOutputFormat` | `s16le` | 原始音频管道格式 |
| `drainMode` | `eof-flush` | 源结束时排空解码器内滞留帧，`flush()` 恢复无换行末行 |

**时间基差异**：计划里写的是目标时间基，源实际交付的可能是另一个（24fps 文件走 25fps 计划是合法的）。解析一律采用**源自身的有理时间基**换算，偏离计划时只发一次告警并记入 `lastDrain.timeBaseMismatch`，不会静默改写或丢弃。

**管道排列**：`fd3` 视频原始帧、`fd4` 视频时间戳、`fd5` 音频 PCM、`fd6` 音频时间戳、`fd7` 预览 MJPEG、`fd8` 预览 MP3。原始数据与时间戳是彼此独立的管道，到达顺序无保证，因此两侧都按队列配对，不因先到而丢弃。

**帧/块一致性**：音频原始管道与时间戳管道使用同一 `asetnsamples=n=960:p=1` 重分块，末端不足一块时补静音，保证样本与时间戳严格一一对应（EOF 排空后 `videoFramesWithoutMeta` 与 `videoMetaRowsWithoutFrame` 必须同为 0）。

**数字音频计量**：控制页的电平条与 dBFS 读数来自送编码器的真实样本（`src/audio_meter.js`），不是 CSS 动画。静音、中断、陈旧分别以 `silent` / `stale` 状态在页面上提示，异常由总控界面显示而非吞掉。

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
npm test                    # 单元测试：契约/时间基/排空/计量/媒体探测
npm start                   # 另开终端保持运行（演出总控图形入口见上）
npm run verify              # 端到端：连续切换 + 音画对应 + 输出可解码 + 解码契约
npm run verify:fixtures     # 额外用有限媒体跑不同帧率下的 EOF 排空
npm run verify:ui           # 用真实控制页脚本点击信号源并切换，校验预监与输出声音
```

`npm run verify` 会依次切到三路源，并：

1. 断言内核实际下发给解码器的契约：适配器版本 2.0.0、每路显式计划、`yuv420p`/`passthrough`、有理时间基、`eof-flush`、媒体依赖为已验证版本；
2. 断言切换过程中帧号与样本计数单调前进、样本数始终为帧号 × 1920；
3. 抓取**实际节目输出音频**，用 Goertzel 测量主频，确认与当前播出源的音调一致（440/660/880Hz）；
4. 校验节目音频表来自真实样本（样本块数与 dBFS 均为实算），预监源音频有同样证据；
5. 下载 TS 归档与 HLS 分片，用 ffmpeg 解码，确认无解码错误、帧数充足。

`npm run verify:fixtures`（等价 `node scripts/verify.js --fixtures <dir>`）把 24/25/30fps 的有限文件分别以 2.0.0 显式计划与 1.0.0 旧配置跑到底，逐项断言：以 `eof`（而非传输失败）结束、每帧都有源时间戳、音视频时间戳单调、采用源自身有理时间基、旧配置被转换并标注来源。

`npm run verify:ui`（等价 `node test/ui_click_check.js`）在无浏览器环境用 jsdom 加载**服务端实际下发的 index.html 与 app.js**，用真实 DOM 点击事件驱动：点缩略图进预监、按 TAKE 切节目，断言预监/节目监视器收到真实 JPEG、节目音频 dBFS 与电平条来自计算值、节目音频故障与预监静音等异常确实显示在界面上。可以 `--url` 指向以 `DECODE_ADAPTER_VERSION=1.0.0` 启动的实例，验证旧配置路径下界面交互一致。

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

`HTTP_PORT`(8080)、`HOST`(127.0.0.1)、`OUT_FPS`、`OUT_WIDTH`/`OUT_HEIGHT`、`OUT_SAMPLE_RATE`、`TARGET_LATENCY_MS`(320)、`MAX_VIDEO_BUFFER_MS`(1200)、`MAX_AUDIO_BUFFER_MS`(1500)、`LOCK_SPAN_MS`(700)、`TAKE_TIMEOUT_MS`(6000)、`PPM_CAM1`/`PPM_CAM2`/`PPM_TEST`（源时钟漂移，单位 ppm）、`START_SOURCES`(true)、`PORT_CAM1`/`PORT_CAM2`/`PORT_TEST`（源端口，便于并行起多个实例）。

解码接口相关：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `DECODE_ADAPTER_VERSION` | `2.0.0` | 设为 `1.0.0` 时以旧节目配置启动，经迁移层转换后运行 |
| `DECODE_PIXEL_FORMAT` | `yuv420p` | 解码像素格式（当前仅验证 `yuv420p`） |
| `DECODE_FPS_MODE` | `passthrough` | `passthrough` 或 `cfr` |
| `DECODE_SCALE_FLAGS` | `bilinear` | 缩放算法（`bilinear` / `bicubic` 等） |
| `DECODE_RESAMPLER` | `soxr` | 重采样器 |
| `DECODE_RESAMPLER_PRECISION` | `28` | soxr 精度 |
| `DECODE_DRAIN_MODE` | `eof-flush` | 结束排空策略 |
| `FFMPEG` | `node_modules/ffmpeg-static/ffmpeg` | 实际使用的 ffmpeg 二进制 |

## 已知限制

- 本仓库附带的 `ffmpeg-static` 构建没有 `drawtext`，因此信号源计数器画面由 `@napi-rs/canvas` 在 Node 内逐帧渲染，不依赖 ffmpeg 文字滤镜。
- 实时归档是边写边服务的，读取时末尾可能包含尚在写入的半个 GOP；`npm run verify` 按节目时间扣除最后 2 秒再解码。HLS 分片是完整写入后才出现在清单里的，可直接解码。
- 界面依赖浏览器支持 HLS（hls.js 已内置）；不支持时会回退到服务端编码器的 MJPEG 节目监听画面。
- 本环境没有可用的浏览器运行时，因此界面验证用 jsdom 加载服务端实际下发的页面与脚本并触发真实点击（`npm run verify:ui`）。它覆盖 DOM 交互、内核命令往返与显示值，但不渲染像素、不验证浏览器音视频解码本身。

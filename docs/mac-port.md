# macOS 版实现与原始开发计划

2026-11-12 整理，依据 `main` 分支 `e23d1ad` 的源码。除特别说明外，路径都相对于 `sumatrapdf/`。标「待验证」的内容需要在 Mac 上实际构建后确认。

## 当前实现（2026-11-12）

实现位于 `main` 工作区，不要求长期维护 macOS 专属分支。原 Windows 构建入口保留；Mac 使用 `npm run build:mac`、`npm run install:mac`。

- `ContextNotesCommon.cpp`、`ContextNotesNetworkCommon.cpp`、`ReflowDocumentCommon.cpp` 移到 `src/shared/`，Windows 和 ng 同时编译；原文提取和网页资源继续共用。
- ng 的 `NotesWebBase` 将现有 notes/reflow 事件接到 BrowserView 的 Promise 桥接；界面仍通过 GPUI 布局，不添加原生工具包控件。
- POSIX HTTP 支持请求方法、流式数据、取消和禁止重定向。
- Mac 使用独立 bundle id、数据目录和钥匙串密钥；加密文件采用 AES-256-CBC + HMAC-SHA256，原子替换、0600 权限和跨进程文件锁。Windows 仍用 DPAPI。
- 注释侧栏及宽度保存、选字/单击注释、原文高亮与音标悬停、重排及缓存、历史页、目录字号、离线朗读、应用资源和安装脚本已接入。
- 新建注释同时请求 LLM、合成原文语音，音频就绪后自动播放一次；恢复、重新生成、追问不自动重播。原版 PDF 与重排正文的悬停操作栏均有播放、删除按钮，可从单词移入操作栏；手动重播复用语音缓存；同一单词仍在合成或播放时重复触发会继续当前播放，完成后才重播。
- `-for-testing` 下的注释只保存在内存中；原生测试使用本地模拟服务，不发送真实密钥。

本机验证：ng 基础单元测试通过；真实 WKWebView 的注释读写、GET/POST 流式网络、错误状态、重定向拦截、PDF 选字生成、重排缓存和历史页通过。6000 项目录的字号调整、恢复及行高验证通过。Kokoro 已在 WKWebView 里完成离线音频合成。独立加密测试验证了跨进程解密、随机 IV 和逐字节篡改拒绝。

语音定向验证：

```sh
# 仓库根目录
node tests/notes-autoplay.mjs
node tests/reflow-play.mjs
# sumatrapdf/ 目录
../node_modules/.bin/bun tests/ad-hoc-mac-notes-speech.ts
```

原生语音回归使用真实 WKWebView Web Audio，静音输出并等待完整音频结束，检查 LLM 回复挂起时只自动播放一次，以及正文和重排操作栏的手动重播。

限制：本机没有 Windows C++ 工具链，Windows 编译与原生回归尚需在 Windows 上运行。现有 `tests/reflow-anchor.mjs` 在本机 Chromium 的段落缩放定位断言失败；在未修改的 `origin/main` 上连续两次得到相同结果，属于基线问题。本次没有修改其定位算法。

以下保留原始方案，条目中的“待验证”描述的是开始移植时的状态。

## 原始结论

不另找 mac 阅读器，在本仓库里把 AI 版的改动移植到 SumatraPDF ng。Windows 版继续用原版构建；两个版本共用文档引擎、重排提取和 `src/notes/` 网页层。

不另找的原因：换成 Skim、sioyek 等阅读器，重排要基于另一套文本提取重写，项目符号、水印、矢量图、页眉页脚这些已经调好的处理要重新调，原生集成也要全部重做，能带走的只有 `src/notes/`。

## 原版与 ng

上游基线 `b1a8e22` 里同时有两个程序，说明见 `agents.md` 开头和「SumatraPDF ng」一节。

|          | 原版（当前 AI 版）                       | ng                                                    |
| -------- | ---------------------------------------- | ----------------------------------------------------- |
| 平台     | Windows                                  | macOS、Linux、WebAssembly；Windows 构建只用于测试对照 |
| 界面     | Win32                                    | GPUI（`ext/gpui/gpui.h`），规定不使用平台原生控件     |
| 网页视图 | WebView2                                 | wry，mac 上为 WKWebView                               |
| 代码     | `src/*.cpp`、`src/gui/win/`              | `src/ng/`                                             |
| 构建     | Visual Studio，`scripts/build-local.ps1` | `bun cmd/ng-build.ts`，输出 `out/mac/<dbg\|rel>/`     |

两边共用 `src/shared/`、`src/base/` 和 `ext/`，清单在 `cmd/helper/ng-shared.ts`。`SumatraPDF.cpp`、`MainWindow.cpp`、`Toolbar.cpp`、`TableOfContents.cpp`、`Settings.cpp` 等在 `src/ng/` 里各有一份，修改原版的这些文件不影响 ng。ng 的文档画布在 `src/ng/gui/DocCanvas.cpp`，界面框架在 `src/ng/gui/AppShell.cpp`。

ng 目前没有任何 AI 版功能。

## 改动对照

### 只在原版里，需要在 ng 重做

| 原版文件                                          | 内容                                                                                                 | ng 中的对应位置                                                     |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `src/ContextNotes.cpp`                            | 侧栏网页视图、桥接分发（`NotesCall`）、注释存储与 DPAPI 加密、单击取词、悬停、高亮绘制、阅读历史数据 | 侧栏参照 `src/ng/AIChatPanel.cpp`；与界面无关的逻辑尽量抽到共享文件 |
| `src/ContextNotesNetwork.cpp`                     | 不受 CORS 限制的流式请求和取消                                                                       | 依赖 `HttpRequestStream`，见第 5 步                                 |
| `src/ReflowDocument.cpp`                          | 重排窗口（加载 `notes/reflow.html`）、XHTML 临时文件缓存、视图中心定位                               | ng 的 BrowserView                                                   |
| `src/Canvas.cpp`                                  | 调用 `ContextNotesClick`、`ContextNotesHover`、`PaintContextNotes`、`ContextNotesCancelClick` 的挂钩 | `src/ng/gui/DocCanvas.cpp`（对应关系待验证）                        |
| `src/SumatraPDF.cpp`、`src/MainWindow.cpp`        | 侧栏布局、分隔条（`OnContextNotesSplitterMove`）、显示状态保存、`Alt+Shift+A`                        | `src/ng/SumatraPDF.cpp`、`src/ng/MainWindow.cpp`、`AppShell.cpp`    |
| `src/TableOfContents.cpp`、`gui/win/TreeView.cpp` | 目录字号缩放（使用已有的 `TreeFontSize` 设置）和大目录性能优化                                       | `src/ng/gui/Sidebar.cpp`（GPUI 树）                                 |
| `src/Toolbar.cpp`                                 | 「重排：关／开」按钮文字                                                                             | `src/ng/Toolbar.cpp`                                                |
| `cmd/gen-settings.ts`                             | `ContextNotesWidth` 等设置字段                                                                       | ng 的设置由 `cmd/ng-gen-settings.ts` 单独生成，目前没有这些字段     |

另外，`CanvasAboutUI.cpp`、`CustomZoomDialog.cpp`、`FilterHighlightDraw.cpp` 里也有少量挂钩，移植时逐一对照。

### 两边共用，已经进入 ng 的编译

- `shared/EngineMupdf.cpp`：`ExtractReflowPage`，以及项目符号、水印、矢量图、页眉页脚的处理。接口是 `shared/EngineBase.h` 里的 `ReflowPageData`。
- `shared/Commands.h`、`shared/Accelerators.cpp`、`shared/MenuDefs.cpp`：`CmdContextNotes`、`CmdContextSettings`、`CmdToggleDocumentReflow`，以及对应的快捷键和菜单项。`cmd/ng-gen-commands.ts` 直接复用 `cmd/gen-commands.ts`，所以命令在 ng 里已经存在，缺的是处理函数。
- `shared/ToolbarCommon.cpp`：重排按钮。
- `base/Http.h`、`base/Http.cpp`：`HttpRequestStream`（支持任意请求方法，可取消）。

### 网页层，直接复用

`src/notes/`，JS/HTML/CSS 约 4200 行，页面内资源都用相对路径。

原生需要提供 `window.__sumatra__.call("notes", json)`，其中 `json.action` 是以下 18 种之一：

`read` `write` `remove` `preferences` `ready` `showNotes` `closeNotes` `open` `openPicker` `goto` `highlights` `history` `hideHistory` `restoreHistory` `fetch` `cancelFetch` `export` `copy`

原生通过 `window.dispatchEvent(new CustomEvent(name, {detail}))` 向页面推送事件（`DispatchNotes`），事件有：`storechange`、`netevent`、`annotate`、`deletenote`、`documentchange`、`focusnote`、`notepositions`、`showsettings`、`historychange`。

## Mac 上的开发步骤

### 0. 环境

- 安装 Xcode 命令行工具、bun、Node.js 24 或更新版本。
- 在仓库根目录运行 `npm ci` 和 `npm run vendor:kokoro`。下载脚本只用 Node，mac 上应该能直接运行。
- 构建 ng：`cd sumatrapdf && bun cmd/ng-build.ts -dbg`，产物是 `out/mac/dbg/SumatraPDF` 和 `out/mac/dbg/.bundle.noindex/SumatraPDF AI.app`。构建包放在隐藏且不索引的目录中，应用搜索只保留 `/Applications` 中所有账户可见的安装版。
- 运行：`out/mac/dbg/SumatraPDF -for-testing -log-to-file <日志路径> <pdf>`。加 `-for-testing` 时不恢复会话，也不保存设置。
- mac 上的调试和自动化方法见 `.claude/skills/verify-mac/`。

### 1. 让 ng 编译通过

预计会遇到的问题（待验证）：共享的 `shared/ToolbarCommon.cpp` 包含了只属于原版的 `ReflowDocument.h`，并调用 `ReflowDocumentZoom`、`ReflowDocumentAvailable`。ng 没有这两个函数，可能编译失败，也可能链接失败。

修法：按 `agents.md` 的约定，把这两个函数声明移到共享的 `*Common.h`，注明 `// implemented by each app`，再给 ng 加一个暂时返回 `false` 或 `0` 的实现。之后运行 ng 单元测试：`bun cmd/ng-build.ts -dbg test_util -run -- -for-ai`。

修改共享文件后，要在 Windows 上重新构建原版并跑测试，确认原版没有受影响。

### 2. 评估 ng 的基础体验（决策点）

在加功能之前，先把 ng 当日常阅读器用一两天，检查渲染、目录、搜索、选字、滚动性能和最近文件。

如果基础体验不能接受，退回备选方案：fork Skim，或用 Swift + PDFKit 写一个精简外壳，继续复用 `src/notes/`。那样的话，重排需要单独链接 MuPDF，并把 `EngineMupdf.cpp` 里的重排提取抽成独立模块。

### 3. 网页桥接

ng 的 `src/ng/gui/BrowserView.cpp` 只注入了 `__sumatra__.notify`（`kJsNotifyJs`），没有带返回值的 `call`。需要把原版 `src/gui/win/WebView.cpp` 里 `kJsBridgeScript` 的 `call` 和 `onReply` 两部分移植过来：

- 页面通过 `window.ipc.postMessage` 发送 `{__sumatraCall: 1, id, method, params}`。
- 原生处理完成后，用 `WebViewEval` 执行 `__sumatra__.onReply(id, status, result)`。
- ng 的 ipc 回调收到的是原始字符串，要和现有的 `scroll …`、`notify …` 消息区分开。

资源加载：原版的虚拟主机是 `https://sumatra-notes/` 和 `https://sumatra-reflow/`；ng 用自定义协议，主机名形如 `https://sumatrapdf.<名称>/`（见 `BrowserView.cpp` 里的 `kHostPrefix`）。因为页面只用相对路径，改主机名不需要改页面。

`NotesAssetPath()` 用 `GetModuleFileNameW` 查找 `notes/` 目录，mac 上要改成 `.app/Contents/Resources/notes`，开发时退回到源码目录 `src/notes`。

### 4. 抽出共享逻辑（可以先在 Windows 上做）

建议把 `ContextNotes.cpp` 里与界面无关的部分移到 `src/shared/ContextNotesCommon.cpp`，包括注释存储读写、JSON 处理、`NotesCall` 的动作分发、高亮区间、重排区间校验和阅读历史 JSON。需要各平台实现的函数（加密、窗口、剪贴板、文件选择框）声明在 `ContextNotesCommon.h`。

新文件要登记到 `premake5.files.lua`、`cmd/helper/ng-shared.ts` 和 `cmd/helper/ng-targets.ts`。

这一步不需要 Mac，可以先在 Windows 上完成，并用现有的原生测试验证没有回退。

### 5. 网络

`ContextNotesNetwork.cpp` 调用 `HttpRequestStream(method, url, headers, body, sink, cancel)`，但 `base/Http_posix.cpp` 只有基于 libcurl 的 `HttpPostStream`，而且不处理取消参数。需要在 posix 版里补上：

- `HttpRequestStream`：支持任意请求方法，在 curl 的进度回调里检查取消标志。
- 与 Windows 版一致的重定向拦截和错误响应处理（原生测试覆盖了这些行为）。

### 6. 注释存储与加密

Windows 版的 `context-notes.dat` 用 DPAPI 加密（`LoadNotesStore`、`SaveNotesStore`）。mac 上候选做法：随机密钥存进钥匙串，文件用这个密钥对称加密。具体算法和依赖待定。

Windows 上加密的文件在 mac 上无法解密，迁移注释要用设置里的 JSON 导出、导入（导出文件不含 API Key）。

### 7. 注释侧栏

参照 `src/ng/AIChatPanel.cpp`：上游原版的 AI 聊天侧栏是 Win32 子窗口加 WebView2；ng 里改成了每帧构建的 GPUI 列加 BrowserView，Win32 计时器换成了 shell 的 tick。注释侧栏按同样的思路移植。

侧栏宽度写回 `ContextNotesWidth`，可参照 `AIChatSidebarDx` 的处理方式，并在 `cmd/ng-gen-settings.ts` 里补上相应字段。

### 8. 单击取词、悬停和高亮

在 ng 文档画布的鼠标和绘制处理中，加上与原版 `Canvas.cpp` 相同的四个挂钩。单击延时 `NotesClickTimer` 用的是 Win32 `SetTimer`，改用 shell tick 或 `UITask` 延时实现。文字提取和命中判断基于引擎接口，可以放进第 4 步的共享文件。

### 9. 重排

原版的 `ReflowView : WebviewWnd` 加载 `reflow.html`，数据来自共享的 `ExtractReflowPage`，临时 XHTML 由 `GetTempFilePathTemp` 创建（posix 版已有实现）。在 ng 里改用 BrowserView 承载，再接上工具栏按钮、`Ctrl+Shift+R` 和原版视图的定位同步。

### 10. 阅读历史和目录字号

阅读历史是在画布上覆盖一个加载 `history.html` 的网页视图（`CreateNotesView(win, true)`），ng 里用同样的 BrowserView 实现即可。

目录字号缩放需要在 `src/ng/gui/Sidebar.cpp` 的 GPUI 树上重新实现。原版那些针对 Win32 TreeView 的性能优化（分批测量、空闲时同步）不一定还需要，先测 6000 项目录的表现再决定。

### 11. 朗读

`notes/shared/tts.js` 用模块 Worker 运行 Kokoro（ONNX Runtime Web，WASM），失败时退回 `speechSynthesis`。这两种方式在 WKWebView 里都需要实测（待验证）。如果都不可用，可以通过桥接调用上游的 `src/ng/ReadAloud_mac.mm` 使用系统语音。

### 12. 打包和数据目录

- `.app` 由 `cmd/helper/ng-mac-bundle.ts` 生成，需要把 `src/notes/`（包括 `vendor/kokoro`）复制进 `Contents/Resources`。
- 上游 ng 的设置目录是 `~/Library/Application Support/SumatraPDF`。建议 AI 版和 Windows 一样使用独立目录（例如 `SumatraPDF-AI`），并换用独立的 bundle id，避免和官方 ng 共用设置。
- 自用时 ad-hoc 签名即可；要分发给别人才需要签名和公证。
- `package.json` 里的 `build`、`install:local` 调用的是 PowerShell，需要另加 mac 的构建和安装脚本。

## 测试

- 网页层测试与平台无关：`npm test`、`npm run test:reflow`、`npm run test:tts`。注意它们跑在 Playwright 的 Chromium 里，不能代替 WKWebView 实测。
- 现有的原生测试（`tests/*.ts` 中驱动真实窗口的部分）依赖 Windows。mac 上改用上游的控制通道 `cmd/ng-dbg-control.ts`，以及 `tests/mac-control.ts` 提供的鼠标键盘操作，写法可参考 `tests/ad-hoc-mac-highlight.ts`。
- 每次修改共享文件后，都要在 Windows 上重新构建原版并跑测试。

## 建议顺序与待验证清单

1. 让 ng 编译通过，并跑通 ng 单元测试（第 1 步）
2. 评估 ng 基础体验，决定是否继续（第 2 步）
3. 抽出共享逻辑（第 4 步，可以先在 Windows 上做）
4. 完成网页桥接和注释侧栏，跑通「选字 → 生成注释 → 存储」（第 3、5、6、7 步）
5. 单击取词、悬停、高亮（第 8 步）
6. 重排（第 9 步）
7. 阅读历史、目录字号、朗读、打包（第 10–12 步）

待验证：

- `ToolbarCommon.cpp` 是否确实导致 ng 编译失败
- ng 的基础阅读体验能否满足日常使用
- `Canvas.cpp` 中的挂钩在 `DocCanvas.cpp` 里的对应位置
- WKWebView 能否运行 Kokoro 的 WASM 和模块 Worker，以及 `speechSynthesis` 是否可用
- mac 上注释加密采用的具体方案

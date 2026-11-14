# SumatraPDF AI

Windows（Win32）和 macOS（ng / GPUI）统一在 `main` 分支维护，共用文档引擎、AI 注释、重排、阅读历史、主题和阅读统计逻辑。平台目录仅保留窗口、网页容器和系统存储等适配。

在 SumatraPDF 原生阅读器中加入 AI 注释侧栏和按时间分组的阅读历史。AI 调用、提示词、音标解析和离线朗读移植自 `chrome_notes_ex` 的 `4b12e8d` 版本；SumatraPDF 完整源码位于 `sumatrapdf/`，基于 `b1a8e22`。本仓库可独立安装依赖和构建。

## 使用

从桌面或开始菜单打开 **SumatraPDF AI**。在注释侧栏点击齿轮，选择 Gemini、Anthropic 或 OpenAI 兼容接口，填写 API Key、模型和接口地址，测试连接后保存。Gemini 默认模型为 `auto`；提示词、思考深度、音标和单击注释可在设置中调整。

点击 AI 注释、阅读历史或重排工具栏中的月亮／太阳按钮切换深色、浅色主题。主窗口及这些页面同步切换，重新启动后保留选择；也可从主窗口的主题菜单选择跟随系统。

Home 页点击「书库」可添加本地 PDF、EPUB 等文档，Windows 和 Mac 均支持一次选择多本；Mac 可按住 Command 点选，或用 Shift 连选。书库按名称和路径搜索，点击封面或书名打开；重复添加自动去重，文件移动后会提示。移出书库可以撤销，原文件保留在原位置。书库记录保存在本机，重启后保留。 支持网格与列表切换，并记住当前用户的选择。封面按需渲染文档第一页；缓存随源文件修改失效，文件丢失或无法预览时保留类型占位。

在阅读历史中点击「阅读统计」，按日、周、月、年查看页数、注释数和阅读时间。三项指标合并到一张分组柱形图，共用时间轴；页数与注释数用左侧计数轴，阅读时间用右轴，悬停或键盘聚焦查看同一时段的三项数值。显示最近 14 天、12 周、12 个月或 5 年，附期间汇总与明细，周从周一开始。相同文档页面每天仅计一次，停留至少 2 秒后计入；仅前台阅读计时，连续 5 分钟未翻页或滚动时暂停。每条新建注释计一次，重新生成、追问、恢复或删除不改变已有统计。数据从启用统计功能时开始记录，保存在本机。

工具栏的月亮按钮切换深浅主题，注释、重排和统计同步更新。界面默认在启动时跟随系统语言；手动选择其他语言后保留该选择，设置 `FollowSystemLanguage = true` 可恢复自动跟随。本地构建自带原生界面翻译资源，新增网页界面支持中文和英文。

- 单击英文词，或选中文字后点击浮动工具栏的「AI 注释」，生成中文释义、音标和折叠详解。新建注释时，同时请求 LLM 和合成原文语音；音频就绪后自动播放一次。恢复已有注释、重新生成和追问不自动重播。
- 注释首行按「单词 → 朗读按钮 → 音标」排列，点击喇叭即可朗读原词；「详解」可单独展开、折叠。
- 悬停侧栏注释可朗读、追问、重新生成、复制 Markdown 或删除；点击原文或页码返回 PDF。追问按 Enter 发送、Shift+Enter 换行。
- 在原版 PDF 或重排正文中，悬停被注释的单词会显示播放和删除按钮；光标从单词移到操作栏时按钮保持显示。点击播放可重听原文，复用已合成的缓存；同一单词仍在合成或播放时重复触发会继续当前播放，完成后才重播。悬停本身不播放。
- 注释和追问点击删除后直接生效；整条注释删除后可点击「撤销」恢复。
- 注释正文采用1.5倍行高，段落、列表和卡片间距紧凑，行高随注释字号同步缩放。
- 朗读使用本地 Kokoro Bella 美式女声，语速 0.8 倍。模型或运行环境不可用时使用系统语音。
- 阅读历史按今天、昨天和具体日期分组，可搜索文件名和路径。旧版历史没有打开时间，归入「较早记录」。移除记录只移除历史项。
- 拖动 PDF 与右侧注释栏之间的分隔条可调整栏宽，重启后保留。目录顶部的减号、百分比和加号可调整或恢复目录字号，也支持在目录内按住 Ctrl 滚轮缩放。
- 点击缩放按钮旁的「重排：关／开」切换正文重排，按钮会显示当前状态。正文重新排版以适应当前宽度，表格和图片限制在阅读区域内。切换时按原文字符或图片、表格区域定位，保留当前视图中心的内容。重排视图支持翻页、缩放、单击单词或选区生成 AI 注释，与原版共用注释；再次点击重排按钮或「原版」切回。

重排正文默认面向 9–12 岁长文阅读：Arial 常规体（不可用时回退 Verdana 等无衬线字体）、100% 时 13pt（约 17.3px）、1.5 倍行距、左对齐、居中短行和清晰段落间隔；字号仍可缩放。依据 BDA 可读性指南及 WCAG 的显示、间距适配原则，具体数值是产品预设，非儿童专用认证。详见 [排版依据](docs/mac-port.md#儿童阅读排版依据)。

工具栏「背景色」提供米白、纯白、米黄、浅绿、浅蓝和深色，目录、正文重排和注释背景同步；选择按当前账户保存，深浅主题切换会记住最近的浅色背景。

重排会改变文档版式；识别到的矢量框图会作为整图保留并随阅读区域限宽。需要选取图中文字时可切回原版。

重排将确认来自 Wingdings 字体的私有圆点编码转换为标准圆点，保留原文字符索引，避免通用字体显示缺字方框。

无边框、左列只有项目符号的推断表格会还原为列表，续行归入同一列表项；有边框或数据列的表格继续按表格显示。

重排按原页的基线、字号和字体关系组合章节编号与标题，并保留标题的粗体显示。

重排会忽略识别到的大幅、淡灰、透明背景水印，避免将其单独排成图片；框图渲染也使用同一过滤规则。原文件和原版视图保持不变。

重排会在后台按需将页面转换为带阅读顺序的 XHTML，保存到一个临时文件中，并从该文件读取。再次访问已转换页面会直接复用；临时文件保留原文定位信息，关闭文档或阅读器后自动清理。

转换时会根据字体、缩进和行距合并同一段落的连续正文行，缩放时按当前阅读宽度自动换行；段间空白、标题、列表项和表格边界分别保留。

相邻页面页边重复出现的内容会分别放到页眉、页脚区域，保留标志、文字和页码的左、中、右对齐关系。

目录缩放先更新可见条目，长标题换行分批测量；原生字体及完整滚动范围在鼠标键盘空闲后同步，保留选中项、展开状态和正文位置。

启动和切回目录标签时复用已有条目，保留目录搜索结果，避免重复创建整份目录。

| 快捷键                           | 操作               |
| -------------------------------- | ------------------ |
| `Alt+Shift+A`                    | 为选中文字生成注释 |
| `Ctrl+Shift+A`                   | 开关 AI 注释侧栏   |
| `Ctrl+H`                         | 打开阅读历史       |
| `Ctrl+Shift+R`                   | 切换正文重排       |
| 历史页 `Ctrl+F`                  | 聚焦历史搜索       |
| 侧栏 `Ctrl` 加 `+` / `-` / `0`   | 调整或恢复注释字号 |
| 重排页 `Ctrl` 加 `+` / `-` / `0` | 调整或恢复正文字号 |

## 构建与安装

### macOS

需要 Xcode 命令行工具、Node.js 24 或更新版本及 clang-format；Bun 由 `npm ci` 安装。构建当前 Mac 的本机架构：

```sh
npm ci
npm run vendor:kokoro
npm run build:mac
npm run install:mac -- --launch
```

应用安装到所有账户可见的 `/Applications/SumatraPDF AI.app`，需要对 `/Applications` 有写入权限，Finder 的「打开方式」可选择它。升级前退出应用，再运行相同的安装命令；升级保留数据，并迁移当前账户旧的 `~/Applications` 安装副本。调试构建使用 `npm run build:mac -- --debug`。

macOS 使用 WKWebView 承载现有网页层，支持选字和单击注释、原文高亮、重排、阅读历史及目录字号。目录顶部的 `−` / 百分比 / `+` 调整字号，也支持目录内按住 Control 或 Command 滚轮缩放。Windows 默认快捷键中的 Control 在 Mac 主窗口通常对应 Command；注释和重排网页内两者均可使用。朗读优先使用本地 Kokoro，失败时使用系统语音。

打开 PDF 后，点击顶部「重排：关/开」或「查看（View）→ 正文重排」切换重排，也可按 `Command+Shift+R`。重排支持文字缩放、返回原版，以及与注释侧栏同步的深浅主题。

设置、注释、书库记录、统计与 API Key 保存在当前用户的 `~/Library/Application Support/SumatraPDF-AI`，与官方 ng 隔离。`context-notes.dat` 是普通 JSON 文件（保留原扩展名），Mac 文件权限为 0600；新数据不加密，也不访问钥匙串。首次读取旧加密文件并解密成功后，保留 `.encrypted.bak` 再原子替换为 JSON，Mac 此次迁移可能需要一次旧钥匙串授权；取消后本次运行不再重试，原文件保留。不同用户的个人数据分别保存。界面导出、导入 JSON 仍不包含 API Key。

Mac 共享书库读取 `/Users/Shared/SumatraPDF-AI/library.json`，格式与本地存储一致，仅包含 `library:` 记录；PDF 等文件可放在该目录的 `Books` 子目录，并为所有账户设置读取权限。共享书籍显示“共享书库”，所有账户都能打开；个人移除操作不修改共享目录。

Mac 构建包位于 `sumatrapdf/out/mac/rel/.bundle.noindex/SumatraPDF AI.app`，开发副本不参与应用搜索；安装版固定保留在 `/Applications/SumatraPDF AI.app`。使用本地 ad-hoc 签名，未做公开分发所需的 Developer ID 签名与公证。

### Windows

需要 Windows x64、Node.js 24 或更新版本、Visual Studio C++ 构建工具与 Windows SDK，以及可从 PATH 调用的 Ninja 和 clang-format。当前构建使用 MSVC 14.52、Windows SDK 10.0.26100.0。从 **x64 Developer PowerShell for Visual Studio** 进入本目录运行：

```powershell
npm ci
npx playwright install chromium
npm run vendor:kokoro
.\scripts\build-local.ps1 -Configuration rel
.\scripts\install-local.ps1 -Launch
```

`package-lock.json` 固定依赖，包括 Bun 1.4.4、Playwright 1.60.0、Kokoro 1.2.1、Transformers.js 3.8.1 和 phonemizer 1.2.1。`npm ci` 会安装 Bun 的本机二进制；如使用 `--ignore-scripts`，还需运行 `node node_modules/bun/install.js`。浏览器安装仅测试需要。

`vendor:kokoro` 从固定模型版本下载约 163 MB 的 fp16 模型并校验 SHA-256，把运行库、声音和许可证写入 `sumatrapdf/src/notes/vendor/kokoro/`；已有校验通过的模型会直接复用。首次准备依赖需要联网，安装后的朗读可离线使用。可通过 `HTTPS_PROXY` 或 `HF_ENDPOINT` 配置下载网络。生成的语音资源、`node_modules/`、`.tools/` 和测试产物不纳入源码。

构建默认使用开发者命令行环境，也支持本机可选的 `.tools/toolchain.json`，其中指定 `msvc`、`sdk` 与 `sdkVersion`。重建全部产物可增加 `-Clean`；发行版输出到 `sumatrapdf/out/rel64/`。升级安装前需关闭已安装的 SumatraPDF AI。

## 本地数据与历史迁移

程序默认安装到 `%LOCALAPPDATA%\Programs\SumatraPDF-AI`，创建当前用户的桌面、开始菜单快捷方式和卸载项。现有 SumatraPDF 保留；首次安装会把检测到的旧配置复制到独立数据目录，带入已有阅读历史。后续升级沿用 AI 版设置。

升级时在正常退出程序后重跑同一条安装命令（自定义目录继续传入相同的 `-InstallPath`）。安装脚本会在原安装目录替换二进制及完整界面资源；已有阅读历史、目录字号、右栏宽度、API 设置和注释数据均保留。

安装后可右键 PDF，在「打开方式」中选择 **SumatraPDF AI**；这会使用 AI 版的独立设置和注释。默认 PDF 打开程序由你在 Windows 中选择。

设置和注释保存在 `%LOCALAPPDATA%\SumatraPDF-AI`；`context-notes.dat` 使用普通 JSON 保存，API Key 也保存在此文件中，不使用 DPAPI；旧版 DPAPI 文件首次读取后自动备份并迁移。PDF 注释按内容指纹关联，改名或移动后可恢复。生成时会向设置的 AI 接口发送选中文字和上下文。迁移注释请使用设置中的 JSON 导出、导入，导出文件不包含 API Key。

可从 Windows 应用列表卸载，或运行安装目录中的 `uninstall-local.ps1`。卸载保留数据目录。

首次安装会检查旧版的 LocalAppData 和 Roaming 配置，优先选择有阅读历史的有效配置，再比较保存时间。已经创建 AI 版配置时，可先预览旧历史合并：

```powershell
.\scripts\restore-history.ps1 -DryRun
# 正常退出 SumatraPDF AI 后应用：
.\scripts\restore-history.ps1 -Apply
```

恢复仅合并 `FileStates`，同路径保留 AI 版状态，其他 AI 设置和会话保持原样。应用前在 AI 数据目录的 `backups` 中保存两份原配置及 `context-notes.dat` 原始副本；注释和 API 设置文件本身保持原样。需要撤回时，退出程序后把对应备份中的 `AI-settings-before.txt` 复制回 `SumatraPDF-settings.txt`。

## 验证与源码

```powershell
npm test                  # 注释界面、网络请求、千条历史搜索
npm run test:history      # 历史解析与合并 fixture
npm run test:tts          # 拦截外网后的离线语音合成
npm run test:reflow       # HTML 重排与文本定位
node tests/notes-autoplay.mjs # 并行合成、自动播放一次及手动重播
node tests/reflow-play.mjs    # 重排正文的悬停播放、删除与操作栏保持
npm run test:native       # 真实原生窗口与 PDF
npm run test:click        # 单击注释
npm run test:perf         # 原生性能
npm run test:home         # 旧历史封面与启动回归
npx bun tests/toc-zoom.ts      # 目录缩放与设置保留
npx bun tests/toc-zoom-perf.ts # 6000 项目录的缩放响应、滚动范围和筛选
npx bun tests/toc-font-render.ts # 目录缩放及横向滚动后的文字背景
npx bun tests/toc-activation-perf.ts --restore # 启动恢复和目录标签切换性能、绘制及搜索状态
npx bun tests/notes-width.ts   # 右侧注释栏宽度
npx bun tests/reflow-native.ts # 原生重排、表格图片与注释
```

测试从本仓库安装的 Playwright 加载 Chromium；原生测试还需要编译完成的发行版及可用的 Windows 桌面会话。测试产物写入 `.test-artifacts/`，AI 请求使用本地模拟服务。

浏览器测试覆盖注释、追问、草稿、删除撤销、导入与历史搜索；原生测试覆盖真实 PDF 选区、流式请求、高亮锚点、JSON 落盘、无时间戳的旧历史、改名后重开恢复，以及无 CORS 接口、错误响应、重定向拦截、取消和关闭窗口时的请求清理。

性能回归覆盖无注释悬停不提取文字、有限 UIA 文本预览按需读取、离屏页面虚拟化，以及普通启动时不为旧历史生成封面或自动隐藏失效路径。历史页不会预先打开列表中的文档。

共用注释逻辑在 `sumatrapdf/src/shared/ContextNotesCommon.cpp`，共用重排逻辑在 `sumatrapdf/src/shared/ReflowDocumentCommon.cpp`；Mac 界面与旧版加密数据迁移适配在 `sumatrapdf/src/ng/ContextNotes.cpp` 和 `NotesStorage_mac.mm`，PDF 内容提取在 `sumatrapdf/src/shared/EngineMupdf.cpp`。侧栏、历史与重排界面位于 `sumatrapdf/src/notes/`，复用模块在其 `shared/` 下。SumatraPDF 许可证见 `sumatrapdf/COPYING` 和 `COPYING.BSD`。Kokoro、Transformers.js 和 phonemizer 的 Apache-2.0 许可证，以及 ONNX Runtime 的 MIT 许可证，保存在 `notes/vendor/kokoro/LICENSE.*` 并随程序安装；ONNX Runtime 原文固定于上游 `89f8206`，源码副本位于 `scripts/licenses/`，打包时校验 SHA-256。

Mac 原生验证（从 `sumatrapdf/` 运行）：

```sh
../node_modules/.bin/bun cmd/ng-build.ts -dbg test_util -run -- -for-ai
../node_modules/.bin/bun tests/ad-hoc-mac-notes.ts
../node_modules/.bin/bun tests/ad-hoc-mac-notes-speech.ts
../node_modules/.bin/bun tests/ad-hoc-mac-toc.ts
python3 tests/ad-hoc-notes-storage.py
python3 tests/ad-hoc-mac-crypto.py
../node_modules/.bin/bun tests/ad-hoc-mac-store.ts
python3 tests/ad-hoc-mac-notes-close.py
```

原生验证使用临时数据目录和本地模拟 AI 服务，覆盖实际 WKWebView 的 Promise 桥接、注释存储、流式请求和取消、选字生成注释、重排缓存及历史页；同时检查离线 Kokoro 合成或系统语音回退。存储验证使用临时目录及模拟旧版密钥，覆盖明文读写、迁移备份、权限、损坏文件保护和取消授权后不重复尝试，不访问真实钥匙串。

语音原生回归使用真实 WKWebView 的 Web Audio，静音输出并等待完整音频结束，验证 LLM 回复尚未返回时自动播放一次，以及正文和重排的手动重播。

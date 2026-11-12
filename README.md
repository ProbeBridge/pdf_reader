# SumatraPDF AI

在 SumatraPDF 原生阅读器中加入 AI 注释侧栏和按时间分组的阅读历史。AI 调用、提示词、音标解析和离线朗读移植自 `chrome_notes_ex` 的 `4b12e8d` 版本；SumatraPDF 完整源码位于 `sumatrapdf/`，基于 `b1a8e22`。本仓库可独立安装依赖和构建。

## 使用

从桌面或开始菜单打开 **SumatraPDF AI**。在注释侧栏点击齿轮，选择 Gemini、Anthropic 或 OpenAI 兼容接口，填写 API Key、模型和接口地址，测试连接后保存。Gemini 默认模型为 `auto`；提示词、思考深度、音标和单击注释可在设置中调整。

- 单击英文词，或选中文字后点击浮动工具栏的「AI 注释」，生成中文释义、音标和折叠详解。
- 注释首行按「单词 → 朗读按钮 → 音标」排列，点击喇叭即可朗读原词；「详解」可单独展开、折叠。
- 悬停注释可朗读、追问、重新生成、复制 Markdown 或删除；点击原文或页码返回 PDF。追问按 Enter 发送、Shift+Enter 换行。
- 注释和追问点击删除后直接生效；整条注释删除后可点击「撤销」恢复。
- 注释正文采用1.5倍行高，段落、列表和卡片间距紧凑，行高随注释字号同步缩放。
- 朗读使用本地 Kokoro Bella 美式女声，语速 0.8 倍。模型或运行环境不可用时使用系统语音。
- 阅读历史按今天、昨天和具体日期分组，可搜索文件名和路径。旧版历史没有打开时间，归入「较早记录」。移除记录只移除历史项。
- 拖动 PDF 与右侧注释栏之间的分隔条可调整栏宽，重启后保留。目录顶部的减号、百分比和加号可调整或恢复目录字号，也支持在目录内按住 Ctrl 滚轮缩放。
- 点击缩放按钮旁的「重排：关／开」切换正文重排，按钮会显示当前状态。正文重新排版以适应当前宽度，表格和图片限制在阅读区域内。切换时按原文字符或图片、表格区域定位，保留当前视图中心的内容。重排视图支持翻页、缩放、单击单词或选区生成 AI 注释，与原版共用注释；再次点击重排按钮或「原版」切回。

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

升级时在正常退出程序后重跑同一条安装命令（自定义目录继续传入相同的 `-InstallPath`）。安装脚本会在原安装目录替换二进制及完整界面资源；已有阅读历史、目录字号、右栏宽度、API 设置和加密注释数据均保留。

安装后可右键 PDF，在「打开方式」中选择 **SumatraPDF AI**；这会使用 AI 版的独立设置和注释。默认 PDF 打开程序由你在 Windows 中选择。

设置和注释保存在 `%LOCALAPPDATA%\SumatraPDF-AI`；`context-notes.dat` 使用 Windows 当前用户 DPAPI 加密。PDF 注释按内容指纹关联，改名或移动后可恢复。生成时会向设置的 AI 接口发送选中文字和上下文。迁移注释请使用设置中的 JSON 导出、导入，导出文件不包含 API Key。

可从 Windows 应用列表卸载，或运行安装目录中的 `uninstall-local.ps1`。卸载保留数据目录。

首次安装会检查旧版的 LocalAppData 和 Roaming 配置，优先选择有阅读历史的有效配置，再比较保存时间。已经创建 AI 版配置时，可先预览旧历史合并：

```powershell
.\scripts\restore-history.ps1 -DryRun
# 正常退出 SumatraPDF AI 后应用：
.\scripts\restore-history.ps1 -Apply
```

恢复仅合并 `FileStates`，同路径保留 AI 版状态，其他 AI 设置和会话保持原样。应用前在 AI 数据目录的 `backups` 中保存两份原配置及加密的 `context-notes.dat` 原始副本；注释和 API 设置文件本身保持原样。需要撤回时，退出程序后把对应备份中的 `AI-settings-before.txt` 复制回 `SumatraPDF-settings.txt`。

## 验证与源码

```powershell
npm test                  # 注释界面、网络请求、千条历史搜索
npm run test:history      # 历史解析与合并 fixture
npm run test:tts          # 拦截外网后的离线语音合成
npm run test:reflow       # HTML 重排与文本定位
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

浏览器测试覆盖注释、追问、草稿、删除撤销、导入与历史搜索；原生测试覆盖真实 PDF 选区、流式请求、高亮锚点、加密落盘、无时间戳的旧历史、改名后重开恢复，以及无 CORS 接口、错误响应、重定向拦截、取消和关闭窗口时的请求清理。

性能回归覆盖无注释悬停不提取文字、有限 UIA 文本预览按需读取、离屏页面虚拟化，以及普通启动时不为旧历史生成封面或自动隐藏失效路径。历史页不会预先打开列表中的文档。

原生注释集成在 `sumatrapdf/src/ContextNotes.cpp`，重排窗口在 `sumatrapdf/src/ReflowDocument.cpp`，PDF 内容提取在 `sumatrapdf/src/shared/EngineMupdf.cpp`。侧栏、历史与重排界面位于 `sumatrapdf/src/notes/`，复用模块在其 `shared/` 下。SumatraPDF 许可证见 `sumatrapdf/COPYING` 和 `COPYING.BSD`。Kokoro、Transformers.js 和 phonemizer 的 Apache-2.0 许可证，以及 ONNX Runtime 的 MIT 许可证，保存在 `notes/vendor/kokoro/LICENSE.*` 并随程序安装；ONNX Runtime 原文固定于上游 `89f8206`，源码副本位于 `scripts/licenses/`，打包时校验 SHA-256。

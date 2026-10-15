# NoobIDE 安装与使用说明（简体中文）

[English version](install.en.md) · [发布说明模板](release-notes-template.md) · [验收清单](acceptance.md)

<!--
Feature S28.6 (agent-check). Every statement below was checked against the code and tests at the commit that adds
this file. Capabilities cite their feature ids (harness/features.json, status "done") in HTML comments so a reviewer
can check them. Rules for editing: only add a capability together with a done feature that proves it (AGENTS.md,
PLAN §4/§9); anything that depends on S28.4 (upgrade/uninstall), S28.2/S28.3 (signing) or H.1 (minimum OS versions)
stays marked as pending until that work is done.
-->

> **当前状态（请先读）**
>
> - 安装包**还没有签名**（Apple 公证和 Windows 代码签名正在准备中）。第一次打开时系统会提示风险，下面写了怎么处理。
> - Windows 安装包和 macOS 下载安装的首次启动，还没有在全新的电脑上完成验收（见 [验收清单](acceptance.md)）。
> - 升级会保留你的设置、最近的项目和本地历史：已在 Mac 上用打包好的两个版本测试过；Windows 安装包的升级和卸载还需要在真实的
>   Windows 电脑上确认（标有“Windows：验证中”的地方）。
> - 支持的最低系统版本还没有确定（待负责人任务 H.1）。
> - 可选的 AI 助手（见第 10 节）已经用模拟的服务商测试过；用真实的 Anthropic 和 OpenAI 密钥检查还没有完成。

## 1. 系统要求

| 项目     | 要求                                                                                             |
| -------- | ------------------------------------------------------------------------------------------------ |
| Mac      | **Apple Silicon**（M1 及以后的芯片），原生 arm64 应用。不支持 Intel Mac，不支持通过 Rosetta 运行 |
| Windows  | **Windows x64**（64 位 Intel / AMD 处理器）。暂不支持 Windows on Arm                             |
| 最低系统 | **待定**（负责人任务 H.1）。确定后会写进发布说明                                                 |
| 其他软件 | 不需要安装 Node.js、Git 或浏览器插件。NoobIDE 自带运行网页所需的一切                             |
| 网络     | 不需要。核心功能可以完全离线使用（见第 7 节）                                                    |

<!-- Apple Silicon arm64 only: S06.2 (needs_manual_check, arch inspection), S28.1 DMG arm64; Windows x64: S02.7
(needs_manual_check). No Node.js needed: Electron bundles Node (ADR 0004); clean-machine proof is S29.1/S29.2. -->

Linux、Intel Mac 和 Windows on Arm 以后再评估。

## 2. 安装

### 2.1 Apple Silicon Mac

1. 下载 `NoobIDE-<版本号>-arm64.dmg`。
2. 双击打开 DMG。窗口里有 NoobIDE 图标和“Applications（应用程序）”文件夹的快捷方式。
3. 把 **NoobIDE** 拖到 **Applications** 上。复制完成后，在访达侧栏里点 DMG 旁边的推出按钮。
4. 在“启动台”或“应用程序”文件夹里打开 NoobIDE。

**第一次打开时（未签名版本）：** macOS 会提示无法验证这个应用的开发者，不让它打开。这是因为安装包还没有经过 Apple
公证，不代表文件损坏。处理方法：

1. 在提示框里点“完成”（**不要**点“移到废纸篓”）。
2. 打开 **系统设置 → 隐私与安全性**，向下滚动，在“安全性”部分找到关于 NoobIDE 的提示，点 **仍要打开**。
3. 再确认一次“打开”，可能需要输入电脑的登录密码。之后再打开就不会再问了。

只在确认安装包来自 NoobIDE 官方发布渠道时这样做。不要用终端命令去掉系统的安全标记。提示的具体文字因 macOS
版本不同而略有差别。签名并公证的版本（S28.2）发布后，正常情况下不再需要这一步。

### 2.2 Windows x64

1. 下载 `NoobIDE-Setup.exe`。
2. 双击运行。安装**不需要管理员权限**，只装给当前用户，没有安装向导页：短暂显示安装动画后，NoobIDE 会自动打开。
3. 安装后，开始菜单和桌面上会有 **NoobIDE** 快捷方式。程序文件放在 `%LOCALAPPDATA%\NoobIDE`，位置不能更改。

**第一次运行时（未签名版本）：** Windows 可能显示蓝色的“Windows 已保护你的电脑”（SmartScreen）。处理方法：点
**更多信息**，确认应用名称是 NoobIDE-Setup.exe，再点 **仍要运行**。只在确认安装包来自 NoobIDE 官方发布渠道时这样做。
即使以后有了签名，较新的版本在刚发布时也可能仍然出现这个提示。

在“设置 → 应用 → 已安装的应用”里，NoobIDE 的图标暂时可能显示为通用图标，这不影响使用。

<!-- Squirrel.Windows per-user install to %LOCALAPPDATA%\NoobIDE, shortcuts, no admin: ADR 0012 and
src/platform/squirrel.ts; real install on Windows still pending (S02.7 / S28.1 needs_manual_check). -->

## 3. 第一次使用

- 欢迎页上点 **创建我的第一个网页**，输入名字，选一个模板（个人介绍页、产品展示页、按钮计数器），选择保存位置。默认位置是
  “文稿 / 文档”文件夹里的 `NoobIDE 项目`。项目就是一个**普通文件夹**，可以用任何其他编辑器或浏览器打开。
- 想打开已有的网页文件夹，点 **打开文件夹…**。为了安全，从电脑上打开的文件夹不会自动运行网页脚本，需要先点一次
  **开始预览**；NoobIDE 会记住你的选择。
- 帮助菜单里有 **入门导览**（随时可以重新开始或跳过）和 **术语表**。
- 界面默认是中文，顶栏的 **English** 按钮可以切换到英文。

<!-- S20.1 templates, S20.2 wizard + default location (src/main/create-project-ipc.ts DEFAULT_LOCATION_NAMES),
S14.4 start-preview consent, S23.1–S23.4 walkthrough + glossary, S02.5 / S13.1 language persisted. -->

## 4. NoobIDE 能做什么

下面只列出已经有自动化测试或验证场景证明的功能。

**项目和文件**

- 用三个内置模板创建项目；打开普通文件夹；欢迎页列出最近的项目，找不到的文件夹会标出来。
- 路径里有中文和空格也能正常打开、保存和预览。
- 文件树：新建、重命名、删除（删除的文件进入系统的废纸篓 / 回收站）。已有的文件不会被悄悄覆盖。
- “在访达中显示”（Mac）/“在文件资源管理器中显示”（Windows）。
- 下次打开时恢复上次的项目、打开的文件和布局。
- 在 Mac 和 Windows 之间拷贝项目时，提示对方系统不支持的文件名和大小写冲突，不会自动改名。

<!-- S20.1, S20.2, S03.3, S13.3, S03.4, S08.1, S08.2, S08.3, S08.4, S08.5, S13.4, S13.5 -->

**编辑**

- 多个标签页、语法高亮、缩进、注释、查找和替换、撤销和重做；切换文件时保留编辑状态。
- 字号缩放、浅色 / 深色主题，重启后保留。每个文件显示一句作用说明（页面结构 / 视觉样式 / 交互行为）。
- HTML、CSS、JavaScript 的补全、悬停说明和“整理格式”。具体哪些已验证，见
  [docs/capabilities.md](../capabilities.md)。
- 默认 UTF-8；保留文件原来的换行方式；不是 UTF-8 的文件、二进制文件和过大的文件不会被写坏。

<!-- S09.1, S09.2, S09.3, S24.4, S20.3, S18.1–S18.4, S07.4 -->

**保存和恢复**

- 默认自动保存，也可以手动保存（Ctrl+S / ⌘S）。顶栏用文字和图标显示“未保存 / 正在保存… / 已保存 / 保存失败”。
- 保存失败（只读、文件被占用、磁盘已满等）时，修改留在编辑器里，并说明原因。
- 关闭窗口或退出前会先保存，不会丢掉还没保存的修改。
- 其他程序改了同一个文件时会提示，有冲突时先显示对比再让你选择。
- 程序被强制结束后，下次打开会找回还没保存的修改（先显示对比）。
- 本地历史：每个文件保留旧版本，可以对比后恢复，被删除的文件也能找回。

<!-- S10.1–S10.6, S11.1–S11.3, S12.1–S12.4, S21.1–S21.4 -->

**预览**

- 旁边的预览显示真实网页，支持多个文件、相对路径、图片、ES 模块和读取项目里的 JSON 文件。
- 保存成功并停止输入后自动刷新；也可以改成手动刷新。可以选择入口页面。
- 刷新、停止、在浏览器中打开、桌面宽度 / 手机宽度（只改变宽度，不模拟手机系统）、可拖动的分隔条、窄窗口时的
  “代码 / 预览”切换。高级用户可以打开预览的开发者工具。
- 网页在单独的安全环境里运行：死循环不会卡住编辑器，点“停止”就能恢复；大量 console 输出不会拖慢 NoobIDE；
  网页读不到电脑上的其他文件。
- 每个项目的网页数据（localStorage、Cookie 等）分开保存，可以清除。

<!-- S04.1–S04.4, S14.1–S14.6, S15.1–S15.4, S05.1, S05.2, S05.3, S05.5, S05.7 -->

**发现和理解错误**

- “问题”面板分开显示代码检查、运行时错误、资源加载失败和 console 输出，并对应到正确的那次预览。
- 问题卡片显示文件、行号、解释、建议检查的地方，以及“转到代码”和“显示原始错误”。
- 覆盖 15 类常见问题（例如变量名拼错、括号不配对、找不到元素、脚本 / 图片路径错误、CSS 属性拼错、fetch 失败、
  跨域、JSON 解析）。不确定原因时会说“可能”。
- 变量名拼错时可以一键修正（可以撤销）。

<!-- S16.1–S16.6, S17.1–S17.3, S19.1, S19.2, S22.1–S22.5 -->

**其他**

- 所有主要操作都可以用键盘完成，快捷键按平台显示（Ctrl / ⌘）。状态不只用颜色表示。
- 本地日志（不含你的代码），帮助菜单里可以打开日志文件夹。
- 在“文稿”“桌面”等受系统保护的文件夹里没有权限时，会说明原因和解决办法。
- 断网时可以正常使用（见第 7 节）。
- 可选的 AI 助手，使用你自己的 Anthropic 或 OpenAI 密钥：补全、解释、修改代码，以及以对比形式交给你审核的项目修改
  （见第 10 节）。

<!-- S24.1, S24.3, S13.6, S25.3, S27.2; AI: S31–S35 (section 10) -->

**还没有验证、暂不承诺的部分：** 真实设备上的中文输入法、不同显示缩放和多显示器、睡眠唤醒后的恢复、各平台菜单和窗口习惯的
最终确认、性能指标、签名安装包、用 Windows 安装包升级和卸载。这些会在验证完成后写进发布说明。

<!-- Not claimed: S09.4/S09.5 IME (needs_manual_check), S15.5/S15.6 DPI/monitors (needs_manual_check), S25.1/S25.2
sleep/wake (todo), S24.2 menus/window lifecycle (needs_manual_check), S25.4 preview permission prompts (todo),
S27.1/S27.3 performance (needs_manual_check), S28.2/S28.3 signing (todo), S28.4 Windows installer upgrade/uninstall
(needs_manual_check), S28.5 macOS upgrade of a signed DMG (todo). -->

## 5. 你的数据存放在哪里

### 5.1 项目文件夹里只会多一个文件

你的网页文件就在你选的文件夹里，NoobIDE 不改变它们的结构。NoobIDE 最多只会在项目里写一个文件：
`.noobide/project.json`，里面只有入口页面、预览设置（是否自动刷新）和配置版本号，**不含绝对路径，也不含任何密钥**。
删掉它，项目仍然是一个普通网站。

缓存、历史、恢复数据和日志都**不会**写进项目文件夹。

<!-- S13.2 (tests/integration/project-config.test.ts), AGENTS.md invariant "Project folders stay ordinary". -->

### 5.2 应用数据文件夹

其他数据都放在 NoobIDE 的应用数据文件夹里：

| 系统    | 位置                                                               | 怎么打开                                                                      |
| ------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| Windows | `%APPDATA%\NoobIDE`（`C:\Users\<用户名>\AppData\Roaming\NoobIDE`） | 按 Win+R，输入 `%APPDATA%\NoobIDE`，回车                                      |
| macOS   | `~/Library/Application Support/NoobIDE`                            | 访达 → 前往 → 前往文件夹（⇧⌘G），输入 `~/Library/Application Support/NoobIDE` |

里面的内容：

| 内容                   | 文件 / 文件夹                                       | 说明                                                                                                                     | 怎么清除                                                         |
| ---------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| 设置                   | `settings.json`                                     | 界面语言、主题、代码字号、启动时是否重新打开上次的项目。文件损坏时会先备份成 `settings.corrupt-<时间>.json` 再用默认设置 | 退出 NoobIDE 后删除这个文件，下次启动用默认设置                  |
| 最近的项目             | `recent-projects.json`                              | 项目文件夹的路径列表                                                                                                     | 欢迎页上“从列表移除”（不会删除你的文件）                         |
| 上次的工作状态         | `session.json`                                      | 上次打开的项目、标签页（相对路径）和布局                                                                                 | 退出后删除这个文件                                               |
| 崩溃恢复副本           | `recovery/`                                         | 还没保存的修改的临时副本，保存成功后自动删除。上限：单个 16 MB、总共 256 MB                                              | 恢复对话框里的“清除全部恢复数据”（清除后无法找回这些修改）       |
| 本地历史               | `history/`                                          | 文件的旧版本。默认上限 256 MB，超过时自动删除最旧的版本，每个文件的最新版本总会保留                                      | 历史窗口里的“清除这个项目的历史”“清除全部历史”                   |
| 日志                   | `logs/`                                             | 运行记录，最多 5 个文件、每个 1 MB，**不记录你的代码内容**                                                               | 帮助 → 打开日志文件夹，然后删除                                  |
| 预览信任和一次性提示   | `preview.json`                                      | 哪些项目可以直接开始预览（只保存路径的哈希值，不保存路径文字），以及已看过的提示                                         | 退出后删除这个文件（之后打开的文件夹需要重新点“开始预览”）       |
| 网页在预览里保存的数据 | `Partitions/` 下以 `noobide-preview-` 开头的文件夹  | 每个项目一份：网页的 localStorage、IndexedDB、Cookie 和缓存                                                              | 预览工具栏 → 高级 → 清除预览数据（只清除当前项目）               |
| 入门导览进度           | `walkthrough.json`                                  | 导览进行到哪一步                                                                                                         | 退出后删除这个文件                                               |
| AI 助手                | `ai-keys.json`、`ai-config.json`、`ai-consent.json` | 你的 API 密钥（加密）、AI 开关、服务商和模型、允许发送代码的项目（只保存路径的哈希值）                                   | AI 设置 → 删除密钥 / 撤销允许；或者退出后删除这些文件（见 10.5） |
| AI 对话和用量          | `ai-chats\`、`ai-usage.json`                        | 保存的 AI 对话，每个项目一个文件夹（用路径的哈希值命名；内容是问题和回答，可能包含代码）；每天的 token 数量和每日上限    | AI 面板 → 历史对话 → 删除；或者退出后删除它们（见 10.5）         |

另外还有 Electron 自己的缓存文件夹（例如 `Cache`、`GPUCache`、`Local Storage`），它们不包含你的项目文件。

本地历史和恢复副本只保存在这台电脑上，**不能代替备份**。重要的项目请另外复制到 U 盘或网盘。

<!-- Paths: src/main/main.ts (app.getPath('userData') + settings.json, recent-projects.json, session.json, recovery/,
history/, logs/, preview.json, walkthrough.json); product name "NoobIDE" (package.json productName, no app.setName).
Limits: src/recovery/journal.ts DEFAULT_JOURNAL_LIMITS, docs/product/local-history.md, src/main/app-log.ts.
Preview partition: src/preview/preview-options.ts (persist:noobide-preview-<sha256>), Electron keeps persistent
partitions under <userData>/Partitions. Settings backup: src/main/json-file.ts. Features: S12.1, S12.3, S13.1,
S13.3, S13.4, S13.6, S14.4, S14.5, S21.4, S23.1. -->

## 6. 升级（手动）

目前 NoobIDE 不会自动更新。升级方法：

1. 在 NoobIDE 里确认所有文件都已保存（顶栏显示“已保存”），然后完全退出（Mac 上按 ⌘Q）。
2. 建议先把上面的应用数据文件夹复制一份作为备份。
3. 安装新版本：
   - **Mac：** 打开新的 DMG，把 NoobIDE 拖到“应用程序”，选择“替换”。
   - **Windows：** 运行新的 `NoobIDE-Setup.exe`，它会直接替换旧版本。
4. 打开 NoobIDE，在“关于 NoobIDE”里确认版本号（Mac：NoobIDE 菜单；Windows：帮助菜单）。

升级不会动你的项目文件夹。设置、最近的项目、上次的工作状态、本地历史、崩溃恢复副本、预览信任和引导进度都放在应用数据文件夹
（第 5.2 节）里。每个版本都使用同一个文件夹，安装新版本也不会替换它，所以**这些数据都会保留**：新版本会用你选的界面语言打开，
重新打开上次的项目，并显示它的历史和你最近的项目。这一点已在 Mac 上用打包好的两个版本测试过；用 Windows 安装包升级的情况
**正在验证中**（Windows：验证中）。

可以从新版本退回旧版本，但不建议这样做。旧版本会使用新版本文件里它能看懂的部分，**不会修改或删除这些文件**，以后再换回新版本
时一切都还在。旧版本运行期间改动的设置不会被保存（界面上会有提示），新格式写的历史和恢复副本也不会显示。

<!-- S28.4 / ADR 0023: tests/integration/app-data-upgrade.test.ts (vN→vN+1, older schema, downgrade byte-for-byte),
tests/e2e/upgrade.spec.ts (packaged macOS vN→vN+1→vN on the default app-data folder: language, session, history,
recent projects). Windows installer upgrade: harness/MANUAL-CHECKS.md#S28.4 (needs_manual_check). Signed DMG upgrade
incl. Gatekeeper: S28.5 (todo). Settings notice for newer files: src/renderer/workbench/SettingsNotice.tsx. About:
S28.1. -->

## 7. 离线使用

断网时，以下功能都可以正常使用：用模板创建项目、编辑和保存、预览刷新、代码检查和错误解释（包括问题卡片）。编辑器、字体和
语言功能都打包在应用里。在离线测试中，NoobIDE 自己没有尝试连接本机以外的任何地址。

可选的 AI 助手（见第 10 节）需要网络；断网时它会说明，其他功能不受影响。

除此之外，需要网络的只有**你的网页自己**请求的外部资源，例如从 CDN 加载的库、外部图片或对互联网地址的 fetch。断网时这些请求会失败，
问题面板会显示并解释。

<!-- S27.2 tests/e2e/offline.spec.ts (6 tests); S02.4 Monaco bundled; S18.1 language services offline. -->

## 8. 卸载

1. 退出 NoobIDE。
2. 删除应用：
   - **Mac：** 把“应用程序”里的 NoobIDE 拖到废纸篓。
   - **Windows：** 设置 → 应用 → 已安装的应用 → NoobIDE → 卸载。
3. 卸载**不会**删除你的项目文件夹。
4. 卸载会删除应用和快捷方式，但会**有意保留应用数据文件夹**（第 5.2 节），这样你的设置、历史和未保存修改的副本不会被误删，
   重新安装后可以接着用。（Windows：验证中。）如果想彻底删除，退出后按第 5.2 节手动删除整个文件夹。注意：这会同时删除本地
   历史和还没恢复的修改。

<!-- ADR 0023: Squirrel uninstall deletes %LOCALAPPDATA%\NoobIDE (program files); the --squirrel-uninstall hook only
removes shortcuts and quits (src/platform/squirrel.ts runSquirrelAction, squirrel.test.ts). App data in
%APPDATA%\NoobIDE is kept. macOS drag-to-Trash never touches ~/Library/Application Support. Windows steps:
harness/MANUAL-CHECKS.md#S28.4. -->

## 9. 遇到问题时

- 帮助 → **打开日志文件夹**，把日志文件附在反馈里。日志不包含你的代码，但包含系统版本和应用版本。
- 在反馈里写上 NoobIDE 版本（“关于 NoobIDE”里）、系统版本、电脑型号，以及你做了什么、看到了什么。

## 10. AI 助手（可选）

NoobIDE 可以借助 AI 模型在你输入时补全代码、解释代码和错误、按你的要求修改选中的代码，以及为项目提出修改。AI 是**可选的**：
没有密钥、关闭 AI 或者断网时，本说明里的其他功能完全不变。

### 10.1 获取密钥

NoobIDE 没有自己的账号系统，它使用**你自己的 API 密钥**连接下面两家服务商之一：

- **Anthropic（Claude）：** 登录 <https://console.anthropic.com>，在 Billing（账单）里添加付款方式或充值，然后在 API keys
  里创建密钥（以 `sk-ant-` 开头）。
- **OpenAI：** 登录 <https://platform.openai.com>，在 Billing 里充值，然后在 API keys 里创建密钥（以 `sk-` 开头）。

然后在 NoobIDE 里：帮助 → **AI 设置…**（也可以在命令列表里找到）。选择服务商，粘贴密钥，点**保存密钥**，再点**测试连接**。
密钥只在你粘贴时可见，保存后不会再显示。

### 10.2 费用

**费用由你的密钥所属账户支付**，按 Anthropic 或 OpenAI 的价格计费；NoobIDE 不收任何费用。AI 助手面板里的回答会显示用了多少
token。自动补全在你停顿输入后才发送一个很小的请求，继续输入就会取消。想控制费用，可以在服务商的控制台设置每月上限，在 AI
设置 → 模型里为不同用途选择更小的模型（自动补全默认就用小而快的模型），或者关闭自动补全。

### 10.3 会发送什么，什么时候会问你

第一次在某个项目里使用 AI 时，NoobIDE 会问你一次：是否允许把这个项目的代码发送给服务商。允许之前不会发送项目里的任何内容；
你可以随时在 AI 设置 → 当前项目里**撤销允许**。这个选择按项目记在应用数据文件夹里（见 10.5），不会写进项目。

| 你使用的功能                                                   | 会发送的内容                                                                                             |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 自动补全（输入时出现的灰色文字）                               | 当前文件里光标前最多 4000 个字符、光标后最多 1000 个字符。超过 200000 个字符的文件不使用                 |
| AI 助手面板：提问、“让 AI 解释选中的代码”、问题卡片上的“问 AI” | 你的问题、这段对话之前的消息，以及输入框上方列出的上下文（文件、选中内容、问题）。发送前可以删掉任何一项 |
| 用 AI 修改代码（Ctrl+I / ⌘I）和“用 AI 修复”                    | 你的要求、选中的代码和前后几行，或者问题和它所在的文件                                                   |
| “修改项目”（智能体）                                           | 你的要求，以及助手用读取工具（列出、读取、搜索）打开的项目文件、当前的问题和预览控制台                   |

助手**不能**读取项目以外的文件、隐藏文件（以 `.` 开头的名字，例如 `.env`）、`.noobide` 和 `node_modules`，也不能运行命令。
它想做的每一处修改都会以**对比（diff）**的形式给你看，由你逐个接受或拒绝；接受的修改会像你自己的编辑一样保存（有本地历史，
整轮修改可以在历史窗口里一起撤销）。文件里或预览控制台里的文字只会被当作数据，绝不会被当作给助手的指令。

### 10.4 密钥保存在哪里

密钥用操作系统的安全存储加密（macOS 钥匙串、Windows 数据保护），保存在应用数据文件夹的 `ai-keys.json` 里。它只留在 NoobIDE
的后台进程中：不会再显示在窗口里，不会写进日志，也不会写进项目文件夹。如果这台电脑没有可用的安全存储，NoobIDE **不会**保存
密钥，AI 保持关闭，并会说明原因。在 AI 设置里点**删除密钥**即可删除。

### 10.5 关闭 AI

- AI 设置 → 关闭**启用 AI 功能**：所有 AI 按钮、面板和补全都会消失。
- 关闭**输入时显示 AI 补全建议**：保留 AI 助手面板，只停止自动补全。
- AI 设置 → 当前项目里的**撤销允许**：不再发送这个项目的代码。

应用数据文件夹（见 5.2）里和 AI 有关的文件：`ai-keys.json`（加密的密钥）、`ai-config.json`（开关、服务商和模型）、
`ai-consent.json`（允许发送代码的项目，只保存路径的哈希值）、`ai-chats\`（保存的对话，每个项目一个文件夹，从不写进项目文件夹；每个项目最多
50 个对话、20 MB，超出时先删除最旧的）和 `ai-usage.json`（每天每个服务商用了多少 token，以及 AI 设置里的每日上限）。退出 NoobIDE
后删除它们，就能把 AI 完全恢复到初始状态。撤销某个项目的允许，或者从最近项目列表中移除找不到的项目时，会问你要不要一起删除它的对话。

### 10.6 离线时

断网时 AI 功能连不上服务商：AI 助手面板和修改框会说明这一点，自动补全不会出现。其他功能都不受影响。NoobIDE 只会连接
`api.anthropic.com` 或 `api.openai.com`，而且只在你使用 AI 功能或测试密钥时才连接。

**状态：** 所有 AI 功能都已经用模拟的服务商做过自动化测试。用真实密钥连接 Anthropic 和 OpenAI 的检查还没有完成（负责人检查
S36.1）；在它通过之前，请把 AI 助手当作预览版。

<!-- S31.1–S31.4 (providers, keys, consent, settings: tests/e2e/ai-settings.spec.ts, tests/integration/ai-service.test.ts),
S32.1 (tests/e2e/ai-inline.spec.ts; bounds src/renderer/ai/inline-context.ts), S33.1/S33.2 (tests/e2e/ai-chat.spec.ts),
S34.1/S34.2 (tests/integration/ai-agent.test.ts, tests/e2e/ai-agent.spec.ts; hidden-file rule src/ai/agent/tools.ts),
S35.1/S35.2 (tests/e2e/ai-edit.spec.ts). Files: src/main/app-data-layout.ts. Decision 0025. Live provider run:
npm run test:ai-live, harness/MANUAL-CHECKS.md#S36.1. -->

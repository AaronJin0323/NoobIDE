# NoobIDE 0.1.0-beta.1 — release notes / 发布说明

<!--
Feature S59.4 (agent-check), drafted 2026-10-18 from release-notes-template.md. Sources: harness/features.json
(only features with status "done" are claimed; their ids follow each bullet), docs/release/install.zh-CN.md /
install.en.md section 4, docs/capabilities.md, docs/release/acceptance.md, owner decisions 2026-10-18
(docs/release/owner-decisions.md). Still to fill in before publishing: release date, file sizes and SHA-256 values
(from the CI release build of this exact version), and the acceptance table (S29.1 / S29.2 for this build). Do not
publish while S36.1 (AI live smoke test, a gate for the beta build) is open. Delete this comment before publishing;
keep the feature-id comments.
-->

## 简体中文

### NoobIDE 0.1.0-beta.1（<发布日期>）

NoobIDE 的第一个**邀请制测试版**：一个给第一次学做网页的人用的桌面编辑器，可以创建、编辑、预览 HTML / CSS / JavaScript
网页，看懂错误，并在出问题时找回自己的代码。这个版本**没有签名**，第一次打开时系统会提示风险，这是正常的（见下面的“签名状态”）。

**下载**

| 平台              | 文件                             | 大小 | SHA-256    |
| ----------------- | -------------------------------- | ---- | ---------- |
| Apple Silicon Mac | `NoobIDE-0.1.0-beta.1-arm64.dmg` | <MB> | `<sha256>` |
| Windows x64       | `NoobIDE-Setup.exe`              | <MB> | `<sha256>` |

打开之前请先核对 SHA-256，方法见 [安装说明 · 检查下载的文件](install.zh-CN.md#23-检查下载的文件)。

**系统要求：** macOS 13 Ventura 或更新（仅 Apple Silicon）；Windows 10 22H2 或更新，或 Windows 11（仅 x64）。
不需要安装 Node.js 或 Git。

<!-- Owner decision H.1 (2026-10-18), docs/decisions/0003-platform-support.md. -->

**签名状态：** macOS：未签名、未公证（首次打开要到 系统设置 → 隐私与安全性 → 仍要打开，见安装说明 2.1）；Windows：未签名
（SmartScreen 提示“Windows 已保护你的电脑”时点 更多信息 → 仍要运行，见安装说明 2.2）。这是测试版的已知情况，公开测试前会完成签名。

<!-- Owner decision H.2 (2026-10-18), ADR 0027; S28.2 / S28.3 blocked until signing credentials exist; S59.3. -->

**新功能**（第一个版本，下面列的都已经有自动化测试证明）

- **创建和打开项目：** 用三个内置模板（个人介绍页、产品展示页、按钮计数器）创建项目，或打开普通文件夹；欢迎页列出最近的项目。
  路径里有中文和空格也能正常打开、保存和预览。 <!-- S20.1, S20.2, S03.3, S03.4, S13.3 -->
- **文件管理：** 新建、重命名、移动、复制、批量选择；删除的文件进系统废纸篓 / 回收站；从电脑里添加文件和图片（只复制，不会覆盖已有文件）；
  图片预览标签页。 <!-- S08.1–S08.5, S52.1–S52.4, S52.6 -->
- **编辑：** 多标签、语法高亮、查找替换（当前文件和整个项目，替换前逐个文件预览）、快速打开文件、命令面板、HTML / CSS /
  JavaScript 的补全、悬停说明和格式化、Emmet 缩写、成对标签同步修改、颜色选择器、自动识别缩进、转到定义和跨文件重命名。具体验证到什么程度见
  [docs/capabilities.md](../capabilities.md)。 <!-- S09.1–S09.3, S18.1–S18.4, S40.5, S43.1–S43.5, S51.1–S51.5, S53.1–S53.4, S57.1–S57.2 -->
- **保存和恢复：** 默认自动保存，顶栏用文字和图标显示保存状态；保存失败时你的修改留在编辑器里并说明原因；其他程序改了同一个文件会先给你对比；
  NoobIDE 被强制退出后，下次启动能找回没保存的修改；本地历史可以对比和恢复以前的版本；整个项目的检查点（AI 修改项目之前也会自动创建）。
  <!-- S10.1–S10.6, S11.1–S11.3, S12.1–S12.4, S21.1–S21.4, S56.1–S56.4 -->
- **预览：** 编辑器旁边显示真实网页，保存后自动刷新；只改 CSS 时不重新加载页面，表单里输入的内容和滚动位置会保留；网页运行在单独的受限环境里，
  死循环不会卡住编辑器，网页读不到你电脑上的其他文件；可以在预览里给元素加标注。 <!-- S04.1–S04.4, S14.1–S14.6, S15.1–S15.4, S05.1, S05.2, S05.3, S05.5, S05.7, S54.2–S54.3, S41.2–S41.7 -->
- **看懂错误：** 问题面板把代码检查、运行错误、加载失败的资源和控制台输出分开显示；问题卡片说明出错的位置、原因和要检查什么，不确定时会说“可能”；
  常见问题的解释从 15 种增加到 25 种，部分问题可以一键修复（可撤销）。 <!-- S16.1–S16.6, S17.1–S17.3, S19.1–S19.2, S22.1–S22.5, S55.1–S55.3 -->
- **AI 助手（可选）：** 输入时补全、解释代码和错误、按要求修改选中的代码、在代码里写 `/ai` 提出要求、为整个项目提出修改（每一处修改都以对比的形式由你接受或拒绝）。
  **需要你自己的 Anthropic（Claude）或 OpenAI API 密钥**，费用由你的密钥账户支付，NoobIDE 不收费；需要联网；第一次在某个项目里使用时会先问你是否允许发送代码。
  不支持其他服务商或“OpenAI 兼容”的地址。不用 AI 时其他功能完全不受影响。见 [安装说明 · AI 助手](install.zh-CN.md#10-ai-助手可选)。
  <!-- S31.1–S31.4, S32.1, S33.1–S33.2, S34.1–S34.2, S35.1–S35.2, S37.1, S39.1–S39.2, S42.1–S42.3; providers: ADR 0025 -->
- **其他：** 所有关键操作都能用键盘完成，状态不只靠颜色表示；离线时核心功能全部可用；本地日志不包含你的代码；第一次打开时界面语言跟随系统（中文系统显示中文，其他显示英文），
  可以在 帮助 → 中文 / English 里切换。 <!-- S24.1, S24.3, S27.2, S13.6, S59.2 -->

**修复**

- 第一个版本，没有上一版可比较。

**升级说明**

- 升级方法见 [安装说明 · 升级](install.zh-CN.md#6-升级手动)。升级前请保存所有文件并退出 NoobIDE。NoobIDE 目前不会自动更新。
- 数据兼容：设置文件版本 1（第一个版本）。以后的版本会沿用同一个应用数据文件夹。
- 已验证：在 Mac 上用打包好的两个版本测试过，升级后设置、最近的项目和本地历史都保留（S28.4）；用 Windows 安装包升级和卸载**尚未验证**。

<!-- S28.4: tests/e2e/upgrade.spec.ts (macOS packaged vN → vN+1 → vN); Windows: harness/MANUAL-CHECKS.md#S28.4. -->

**已知问题**

- **未签名（两个平台）：** 第一次打开会有系统警告，按安装说明第 2 节处理。只从官方发布页面下载，并核对 SHA-256。
- **还在真实设备上确认中：** 全新电脑上的验收（Windows S29.1、Apple Silicon S29.2）、中文输入法、不同的显示缩放和多显示器、睡眠唤醒后的恢复、各平台菜单和窗口习惯、
  Windows 安装包的升级和卸载。这些功能已经实现，但在真实设备上的检查完成之前不作承诺。 <!-- S09.4, S09.5, S15.5, S15.6, S25.1, S25.2, S24.2, S28.4 needs_manual_check -->
- **AI 助手：** 用真实的 Anthropic 和 OpenAI 服务做的检查（S36.1）完成之前，请把它当作预览功能。
- **Windows 内存占用：** 打开一个普通项目时，Windows 上的内存占用略高于 ~700 MB 的目标（约 710 MB），正在优化（S59.5）。macOS 在目标之内。
- Windows 的“设置 → 应用 → 已安装的应用”里 NoobIDE 可能显示通用图标，不影响使用。
- 不支持 Intel Mac、Windows on Arm 和 Linux。

**验收结果**

| 检查                          | Windows x64        | Apple Silicon      |
| ----------------------------- | ------------------ | ------------------ |
| 全新电脑验收（acceptance.md） | 未运行（S29.1）    | 未运行（S29.2）    |
| 测试过的系统版本              | <版本，验收后填写> | <版本，验收后填写> |

## English

### NoobIDE 0.1.0-beta.1 (<release date>)

The first **invite-only beta** of NoobIDE: a desktop editor for people building their first webpages. Create, edit and
preview HTML / CSS / JavaScript, understand errors, and get your code back when something goes wrong. This build is
**not signed**, so your system warns on first launch; that is expected (see "Signing" below).

**Downloads**

| Platform          | File                             | Size | SHA-256    |
| ----------------- | -------------------------------- | ---- | ---------- |
| Apple Silicon Mac | `NoobIDE-0.1.0-beta.1-arm64.dmg` | <MB> | `<sha256>` |
| Windows x64       | `NoobIDE-Setup.exe`              | <MB> | `<sha256>` |

Check the SHA-256 before you open the file: [install guide · Checking the download](install.en.md#23-checking-the-download).

**System requirements:** macOS 13 Ventura or later (Apple Silicon only); Windows 10 22H2 or later, or Windows 11 (x64
only). No Node.js or Git needed.

<!-- Owner decision H.1 (2026-10-18), docs/decisions/0003-platform-support.md. -->

**Signing:** macOS: unsigned and not notarised (on first launch use System Settings → Privacy & Security → Open
Anyway, install guide 2.1); Windows: unsigned (when SmartScreen says "Windows protected your PC", click More info → Run
anyway, install guide 2.2). This is expected for the beta; signing comes before the public beta.

<!-- Owner decision H.2 (2026-10-18), ADR 0027; S28.2 / S28.3 blocked until signing credentials exist; S59.3. -->

**New** (first release; everything below is proven by automated tests)

- **Create and open projects:** three built-in templates (personal introduction, product showcase, button counter)
  or any ordinary folder; the welcome screen lists recent projects. Paths with Chinese characters and spaces open,
  save and preview correctly. <!-- S20.1, S20.2, S03.3, S03.4, S13.3 -->
- **Files:** create, rename, move, copy, multi-select; deleted files go to the system Trash / Recycle Bin; add files
  and images from your computer (always copied, never overwriting an existing file); an image viewer tab.
  <!-- S08.1–S08.5, S52.1–S52.4, S52.6 -->
- **Editing:** tabs, syntax highlighting, find and replace (in the current file and across the project, with a
  per-file preview before replacing), quick open, a command palette, completion, hover information and formatting
  for HTML / CSS / JavaScript, Emmet abbreviations, linked tag editing, a colour picker, automatic indentation
  detection, go to definition and cross-file rename. What exactly is validated is listed in
  [docs/capabilities.md](../capabilities.md). <!-- S09.1–S09.3, S18.1–S18.4, S40.5, S43.1–S43.5, S51.1–S51.5, S53.1–S53.4, S57.1–S57.2 -->
- **Saving and recovery:** autosave by default with the save state shown in words and an icon; when a save fails your
  edits stay in the editor and the cause is explained; a change by another program is compared before anything is
  overwritten; after a forced quit, unsaved edits come back on the next start; local history compares and restores
  earlier versions; whole-project checkpoints (also taken automatically before the AI changes a project).
  <!-- S10.1–S10.6, S11.1–S11.3, S12.1–S12.4, S21.1–S21.4, S56.1–S56.4 -->
- **Preview:** the real webpage beside the editor, refreshed after saving; a CSS-only change updates the styles
  without reloading, so typed form input and the scroll position stay; the page runs in a separate, restricted
  environment, so an endless loop does not freeze the editor and the page cannot read other files on your computer;
  annotate elements in the preview. <!-- S04.1–S04.4, S14.1–S14.6, S15.1–S15.4, S05.1, S05.2, S05.3, S05.5, S05.7, S54.2–S54.3, S41.2–S41.7 -->
- **Understanding errors:** the Problems panel separates code-check problems, runtime errors, failed resources and
  console output; problem cards explain where, why and what to check, and say "may" when the cause is uncertain;
  25 kinds of common problems are explained (up from 15), and some can be fixed with one click (and undone).
  <!-- S16.1–S16.6, S17.1–S17.3, S19.1–S19.2, S22.1–S22.5, S55.1–S55.3 -->
- **AI assistant (optional):** completions while you type, explanations of code and errors, edits to a selection,
  `/ai` requests written in your code, and project changes proposed as diffs you accept or reject change by change.
  **It needs your own Anthropic (Claude) or OpenAI API key**; usage is billed to that key's account and NoobIDE
  charges nothing. It needs a network connection, and it asks once per project before sending any code. Other
  providers and "OpenAI-compatible" endpoints are not supported. Without AI everything else works the same. See the
  [install guide · AI assistant](install.en.md#10-the-ai-assistant-optional).
  <!-- S31.1–S31.4, S32.1, S33.1–S33.2, S34.1–S34.2, S35.1–S35.2, S37.1, S39.1–S39.2, S42.1–S42.3; providers: ADR 0025 -->
- **Other:** every key action works from the keyboard and state is never shown by colour alone; all core features
  work offline; the local log never contains your code; on first launch the interface follows your system language
  (Chinese on a Chinese system, English otherwise), switchable under Help → 中文 / English.
  <!-- S24.1, S24.3, S27.2, S13.6, S59.2 -->

**Fixed**

- First release; nothing to compare with.

**Upgrading**

- How to upgrade: [install guide · Upgrading](install.en.md#6-upgrading-manual). Save all files and quit NoobIDE
  first. NoobIDE does not update itself yet.
- Data compatibility: settings file version 1 (first release). Later versions use the same app-data folder.
- Verified: settings, recent projects and local history are kept after an upgrade, tested on a Mac with two packaged
  versions (S28.4); upgrading and uninstalling with the Windows installer is **not verified yet**.

<!-- S28.4: tests/e2e/upgrade.spec.ts (macOS packaged vN → vN+1 → vN); Windows: harness/MANUAL-CHECKS.md#S28.4. -->

**Known issues**

- **Unsigned on both platforms:** your system warns on first launch; follow section 2 of the install guide. Download
  only from the official release page and check the SHA-256.
- **Still being checked on real hardware:** clean-machine acceptance (Windows S29.1, Apple Silicon S29.2), Chinese
  input methods, display scaling and multiple monitors, recovery after sleep and wake, platform menu and window
  conventions, and upgrading or uninstalling with the Windows installer. These are implemented but not promised until
  those checks pass. <!-- S09.4, S09.5, S15.5, S15.6, S25.1, S25.2, S24.2, S28.4 needs_manual_check -->
- **AI assistant:** until the check against the real Anthropic and OpenAI services (S36.1) has passed, treat it as a
  preview.
- **Windows memory:** with a typical project open, memory use on Windows is slightly above the ~700 MB target (about
  710 MB); a fix is in progress (S59.5). macOS is within the target.
- Under Windows Settings → Apps → Installed apps, NoobIDE may show a generic icon. This does not affect anything.
- Intel Macs, Windows on Arm and Linux are not supported.

**Acceptance results**

| Check                                    | Windows x64              | Apple Silicon            |
| ---------------------------------------- | ------------------------ | ------------------------ |
| Clean-machine acceptance (acceptance.md) | not run yet (S29.1)      | not run yet (S29.2)      |
| OS versions tested                       | <version, after the run> | <version, after the run> |

# Release-notes template / 发布说明模板

<!--
Feature S28.6. Copy this file to docs/release/notes/<version>.md (or the release page) and fill every <…>. Rules:
- zh-CN section first, English second; both say the same thing.
- "New" and "What NoobIDE can do" may only name capabilities proven by a done feature or a passing validation case
  (AGENTS.md "Only claim capabilities that a test or validation scenario proves", PLAN §4/§9). Put the feature ids in
  an HTML comment after each bullet so reviewers can check them. Language features: only what docs/capabilities.md
  lists.
- Platform results come from docs/release/acceptance.md (S29.1 Windows, S29.2 Apple Silicon) for this exact build.
  Never copy results from an earlier build.
- Minimum OS versions come from the platform-support decision (S01.4 / owner task H.1). Until that exists, write
  "to be decided".
- Signing lines must match reality: unsigned until S28.2 / S28.3 are done for this build.
- Delete the guidance comments before publishing; keep the feature-id comments.
-->

## 简体中文

### NoobIDE <版本号>（<YYYY-MM-DD>）

<一两句话说明这个版本最重要的变化。>

**下载**

| 平台              | 文件                         | 大小 | SHA-256    |
| ----------------- | ---------------------------- | ---- | ---------- |
| Apple Silicon Mac | `NoobIDE-<版本号>-arm64.dmg` | <MB> | `<sha256>` |
| Windows x64       | `NoobIDE-Setup.exe`          | <MB> | `<sha256>` |

**系统要求：** macOS <最低版本> 或更新（仅 Apple Silicon）；Windows <最低版本> 或更新（仅 x64）。
不需要安装 Node.js 或 Git。

**签名状态：** <macOS：已签名并公证 / 未签名（首次打开见安装说明）>；<Windows：已签名 / 未签名（SmartScreen 提示见安装说明）>。

**新功能**

- <功能说明，用初学者能懂的话。> <!-- S<xx.y> -->

**修复**

- <修复了什么，用户会注意到什么变化。> <!-- S<xx.y> / issue -->

**升级说明**

- 升级方法见 [安装说明 · 升级](install.zh-CN.md#6-升级手动)。升级前请保存所有文件并退出 NoobIDE。
- 数据兼容：设置文件版本 <N>（上一版 <M>）；<本地历史 / 恢复数据格式是否变化>。<如果有迁移：说明会自动迁移什么，以及不能退回旧版本。>
- 已验证：<vN-1 → vN 升级后设置、最近的项目、本地历史保留（S28.4 Windows / S28.5 macOS 的结果，或“尚未验证”）>。

**已知问题**

- <问题、影响哪个平台、临时解决办法。>

**验收结果**

| 检查                          | Windows x64                    | Apple Silicon                  |
| ----------------------------- | ------------------------------ | ------------------------------ |
| 全新电脑验收（acceptance.md） | <通过 / 未通过的条目 / 未运行> | <通过 / 未通过的条目 / 未运行> |
| 测试过的系统版本              | <版本>                         | <版本>                         |

## English

### NoobIDE <version> (<YYYY-MM-DD>)

<One or two sentences about the most important change in this release.>

**Downloads**

| Platform          | File                          | Size | SHA-256    |
| ----------------- | ----------------------------- | ---- | ---------- |
| Apple Silicon Mac | `NoobIDE-<version>-arm64.dmg` | <MB> | `<sha256>` |
| Windows x64       | `NoobIDE-Setup.exe`           | <MB> | `<sha256>` |

**System requirements:** macOS <minimum> or later (Apple Silicon only); Windows <minimum> or later (x64 only). No
Node.js or Git needed.

**Signing:** <macOS: signed and notarised / unsigned (see the install guide for the first launch)>; <Windows: signed /
unsigned (see the install guide for SmartScreen)>.

**New**

- <What changed, in words a beginner understands.> <!-- S<xx.y> -->

**Fixed**

- <What was fixed and what users will notice.> <!-- S<xx.y> / issue -->

**Upgrading**

- How to upgrade: [install guide · Upgrading](install.en.md#6-upgrading-manual). Save all files and quit NoobIDE first.
- Data compatibility: settings file version <N> (previous <M>); <whether the history / recovery formats changed>. <If
  there is a migration: what is migrated automatically, and that going back to an older version is not supported.>
- Verified: <settings, recent projects and local history kept after vN-1 → vN (S28.4 Windows / S28.5 macOS results,
  or "not verified yet")>.

**Known issues**

- <Issue, affected platform, workaround.>

**Acceptance results**

| Check                                    | Windows x64                     | Apple Silicon                   |
| ---------------------------------------- | ------------------------------- | ------------------------------- |
| Clean-machine acceptance (acceptance.md) | <pass / failed items / not run> | <pass / failed items / not run> |
| OS versions tested                       | <version>                       | <version>                       |

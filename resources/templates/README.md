# Built-in webpage templates (S20.1)

Exactly three templates in v1 (PLAN §2): plain HTML/CSS/JS projects a beginner can read, commented in Chinese
(zh-CN is the default locale). No frameworks, no build step, no network: every asset is a local file referenced by a
relative path, and fonts are the operating system's own (`system-ui`, PingFang SC, Microsoft YaHei), so no font files
are bundled.

| Folder              | zh-CN      | en                    | Entry        | Supports (docs/product/task-script.md)                       |
| ------------------- | ---------- | --------------------- | ------------ | ------------------------------------------------------------ |
| `personal-intro/`   | 个人介绍页 | Personal introduction | `index.html` | Default. Steps 2–7: `h1` heading, styles, button, `userName` |
| `product-showcase/` | 产品展示页 | Product showcase      | `index.html` | Banner, product image, toggle button                         |
| `button-counter/`   | 按钮计数器 | Button counter        | `index.html` | `count` variable used in several places, three buttons       |

## Layout of a template

- `template.json` — manifest read by `src/workspace/templates.ts`: `id` (= folder name), `order`, `default`, `name` and
  `description` in `zh-CN` and `en`, `entry` (the page the preview opens), `files` (exactly the files copied into a new
  project, `/`-separated relative paths) and `thumbnail` (shown by the create-project wizard, **not** copied).
- `template.json` and `thumbnail.svg` stay in the app; only the paths in `files` become the user's project.
- `tests/integration/templates.test.ts` checks every template: manifest valid, files exist with exact case, HTML
  well-formed, every local reference resolves (exact case), and no `http(s):` or protocol-relative URL anywhere.
  `tests/e2e/templates.spec.ts` loads each entry page in Electron offline and requires zero console errors, zero failed
  requests and working buttons.

## Packaging

`forge.config.ts` copies this folder with `packagerConfig.extraResource`, so the packaged app has it at
`<resources>/templates` (outside the asar archive, readable with ordinary `fs`). In development it is read from
`<app path>/resources/templates`. `resolveTemplatesDir()` in `src/workspace/templates.ts` picks the right one.

## Licences and provenance

All files in this folder (HTML, CSS, JS, `images/*.svg`, `thumbnail.svg`) were written by hand for NoobIDE in 2026
(S20.1). They contain no third-party artwork, fonts or code, and are dedicated to the public domain under
[CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) so learners may reuse their pages freely. The names and
the product in `product-showcase` are fictional.

| Asset                                 | Kind         | Author / source       | Licence |
| ------------------------------------- | ------------ | --------------------- | ------- |
| `personal-intro/images/avatar.svg`    | SVG drawing  | NoobIDE project, 2026 | CC0 1.0 |
| `product-showcase/images/product.svg` | SVG drawing  | NoobIDE project, 2026 | CC0 1.0 |
| `button-counter/images/star.svg`      | SVG drawing  | NoobIDE project, 2026 | CC0 1.0 |
| `*/thumbnail.svg`                     | SVG drawings | NoobIDE project, 2026 | CC0 1.0 |
| Fonts                                 | none bundled | OS system fonts       | n/a     |

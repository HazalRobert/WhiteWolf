# WhiteWolf

[English](#english) · [简体中文](#简体中文) · [Privacy / 隐私政策](PRIVACY.md)

## English

WhiteWolf is a free, open-source Chrome extension for reviewing the X accounts you follow and identifying accounts that do not follow you back. It provides manual and automatic unfollow workflows, an account-specific whitelist, and a local activity log.

Version: **1.2.3**. License: **MIT**. Chrome Web Store submission is being prepared; this repository does not claim an approved or published store listing. WhiteWolf is an independent project and is not affiliated with or endorsed by X or Google.

### 1.2.3 scan fix

Explicit unavailable-user placeholders no longer abort Following pagination. Excluded entries are counted separately; automatic processing stays disabled if any are unverified. Verified normal accounts remain available for individual review. See [the changelog and test scope](CHANGELOG.md).

### Features

- Connect to an X tab that you select, verify the signed-in account, and scan paginated following data and relationship information.
- Review a complete scan before unfollowing. Unknown relationships and unconfirmed write results receive separate handling rather than being silently treated as success.
- Manual confirmation, or automatic processing with a preview, explicit confirmation, interval and batch controls.
- Pause scanning in either mode and resume from an in-memory checkpoint after account verification. Pause automatic processing from the main button or sidebar.
- Maintain a whitelist per account, inspect the latest 500 activity records, and export a CSV to your own computer.
- Choose a Minimal theme, WhiteWolf theme, or a custom image theme. Save up to five custom themes, with local crop, zoom, position and opacity controls.
- Ten interface languages: Simplified Chinese, English, French, Spanish, Russian, German, Portuguese, Japanese, Korean and Arabic, including right-to-left Arabic layout.

A scan checkpoint lasts only while the control page remains open. Closing or refreshing it requires a new scan; account changes and session errors also invalidate it. Pausing stops subsequent work but cannot recall a relationship request already sent to X. Resuming automatic processing still requires preview and confirmation. An optional, explicit button follows the author, `@MagicalStocker`; following the author does not unlock functionality.

### Download and install on Windows Chrome

[**Download WhiteWolf 1.2.3 for Windows Chrome (ZIP)**](downloads/WhiteWolf-1.2.3-Windows-Chrome.zip?raw=true). This package is already built; ordinary users do not need Node.js, pnpm or a source build.

1. Extract the ZIP to a permanent folder.
2. Open `chrome://extensions` in desktop Chrome 120 or later and enable **Developer mode**.
3. Select **Load unpacked** and choose the extracted folder that directly contains `manifest.json`.
4. Pin WhiteWolf, sign in to X in the same Chrome profile, then open WhiteWolf, connect the intended X tab and verify the account before scanning.

[Detailed installation instructions / 中文安装说明](downloads/README.md) · [SHA-256 checksum](downloads/SHA256SUMS.txt)

Keep the extracted folder in place. This download provides Windows Chrome installation support; Mac installation and compatibility verification are planned. To upgrade an existing installation, back up its folder, replace the build in the same loaded directory, close the old control page, and reload the extension in Chrome. Loading a different directory may create a separate extension identity and storage.

### Build and load locally

Use Node.js 24 and pnpm 11.25.0. The repository pins dependency versions with `pnpm-lock.yaml` and the package-manager version in `package.json`.

```sh
git clone https://github.com/HazalRobert/WhiteWolf.git
cd WhiteWolf
npx pnpm install --frozen-lockfile
npx pnpm build
npx pnpm test
```

Open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select the generated `dist` directory. Chrome 120 or later is required by the manifest. The `dist` folder is the installable extension; the repository root is the source project.

For an existing unpacked installation, preserve its path and extension identity when replacing the build, close its old control page, reload it in Chrome's extension manager, and verify version 1.2.3. A separately loaded directory or future Web Store installation may have a different extension identity and separate storage.

### Development and verification

```sh
npx pnpm check
npx pnpm dev
npx playwright install chromium
npx pnpm test:browser
npx pnpm test:design
node scripts/scan-pause-browser.mjs
node scripts/unavailable-browser.mjs
node scripts/themed-layout-check.mjs
node tests/theme-image-browser.mjs
```

`dev` serves a local demonstration with synthetic data. Browser checks use isolated profiles and synthetic fixtures; they do not validate a real user's X account. `test:browser` and `test:design` build the extension first. Other browser scripts require an existing `dist` build. They use Playwright's installed Chromium unless `BROWSER_EXECUTABLE` is set to a compatible executable path. Test output and profiles are ignored by Git.

`node scripts/icon-check.mjs` checks the current icons and isolated extension. Its optional historical visual comparison requires `OLD_ICON_DIR` pointing to a directory containing historical `16.png`, `32.png` and `128.png`; otherwise that comparison is explicitly skipped. Historical parser/pagination comparison scripts require the previous source/build and a separately downloaded pinned public fixture, as explained in [the technical notes](docs/technical-review-history.txt). They are not part of the standard unit-test command.

The 1.2.3 release's automated checks used synthetic account data. This publication does not claim a new live-account scan, follow or unfollow test. X's web client is an external dependency and can change; an unavailable client or changed response schema can stop the extension.

### Data and permissions

WhiteWolf has no developer-operated data server, advertising or analytics. It makes requests to X using the selected page's existing signed-in session. Displaying avatars may contact the image host supplied by X. Settings, whitelists, recent activity, unresolved-operation protections and saved themes stay in extension-local storage. Scan results and scan checkpoints remain in memory; exported CSV files are saved only when requested. Custom theme image processing takes place locally. See [PRIVACY.md](PRIVACY.md) for the exact lifecycle and deletion behavior.

Required permissions are `activeTab`, `scripting` and `storage`. The optional `https://x.com/*` permission is requested through an explicit connection action when tab selection requires it. The manifest has no required host permissions and does not request `cookies`, `tabs`, `webRequest` or `debugger` permissions.

### Project layout and license

- `src/`: React interface, local storage, scan/processing engine, X adapter and theme handling.
- `public/`: Manifest V3, icons and bundled theme artwork.
- `tests/`, `scripts/`: unit tests, synthetic browser fixtures and verification tools.
- [LICENSE](LICENSE): project MIT license.
- [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt): retained dependency licenses.
- [ASSET-PROVENANCE.txt](ASSET-PROVENANCE.txt): artwork origins and generation notes.

Report bugs and privacy questions at [GitHub Issues](https://github.com/HazalRobert/WhiteWolf/issues). Avoid posting passwords, cookies, tokens or private account exports. The package is marked `private: true` to prevent accidental npm publication; the source repository is public.

## 简体中文

WhiteWolf 是一款免费、开源的 Chrome 扩展，用于查看你在 X 上关注的账号，识别没有回关你的账号，并通过手动确认或自动队列处理取消关注。支持按账号保存白名单及本地操作记录。

当前版本为 **1.2.3**，采用 **MIT 许可证**。Chrome 应用商店提交正在准备中；本仓库不表示已通过审核或正式上架。WhiteWolf 是独立项目，与 X、Google 无官方关联，也未经其背书。

### 1.2.3 扫描修复

X 明确标记为不可用的账号条目不再中断整页扫描，而是单独计数并继续翻页。存在未核验条目时禁用自动取关，已核验的正常账号仍可逐项手动处理。详见[更新说明与验证范围](CHANGELOG.md)。

### 功能与边界

- 选择并连接已登录的 X 标签页，核验当前账号，分页读取关注列表并核对双方关系。
- 完成扫描后预览候选；不把未知关系当作未回关，不把未确认的写操作当作成功。
- 手动逐项确认，或预览并确认后自动处理；可调整间隔和批次数量。
- 手动、自动模式的扫描均可一键暂停；继续时重新核验账号并从断点接续。自动处理也有顶部和侧栏暂停入口。
- 按账号保存白名单，查看最近 500 条操作记录，主动导出 CSV。
- 简洁、白狼、自定义图片三种外观；最多保存五套自定义皮肤，本地调整裁切、位置、缩放和不透明度。
- 支持中文、英语、法语、西班牙语、俄语、德语、葡萄牙语、日语、韩语、阿拉伯语及阿拉伯语从右向左布局。

扫描断点仅保留在当前控制页面内存中；关闭、刷新页面后需要重新扫描，切换账号或发生会话错误也会使断点失效。暂停会停止后续工作，但不能撤回已经发送给 X 的关注或取消关注请求。恢复自动处理仍需预览和确认。关注作者 `@MagicalStocker` 是独立、自愿的点击操作，不作为任何功能的解锁条件。

### Windows Chrome 直接下载安装

[**下载 WhiteWolf 1.2.3 Windows Chrome 安装包（ZIP）**](downloads/WhiteWolf-1.2.3-Windows-Chrome.zip?raw=true)。已构建完成，无需安装 Node.js 或自行编译。

1. 将 ZIP 完整解压到固定文件夹。
2. 在桌面 Chrome 120 或更新版本打开 `chrome://extensions`，开启“开发者模式”。
3. 点击“加载已解压的扩展程序”，选择直接包含 `manifest.json` 的解压文件夹。
4. 固定 WhiteWolf 图标，在同一浏览器配置登录 X；打开 WhiteWolf，连接对应标签页并核对账号后扫描。

[详细中文安装说明](downloads/README.md) · [SHA-256 校验值](downloads/SHA256SUMS.txt)

安装后保留该文件夹。当前提供 Windows Chrome 安装支持；Mac 安装与适配验证会尽快补上。旧版用户应先备份原目录，再覆盖更新原加载目录内的文件，关闭旧控制页后重新加载扩展；不要卸载或换目录，以免产生新的扩展身份及独立存储。

### 本地构建与安装

准备 Node.js 24，执行上方构建命令：`npx pnpm install --frozen-lockfile`、`npx pnpm build`、`npx pnpm test`。依赖锁文件和 pnpm 版本已固定。

打开 `chrome://extensions`，开启开发者模式，点击“加载已解压的扩展程序”，选择构建生成的 `dist` 文件夹。清单要求 Chrome 120 或更新版本。仓库根目录是源码，`dist` 才是可安装扩展。

已有解压安装应保留原加载路径及扩展身份，替换构建后关闭旧控制页面，在扩展管理页重新加载并确认版本 1.2.3。另行加载目录或以后从商店安装，可能产生不同扩展身份及独立存储。

`npx pnpm dev` 启动本地合成数据演示。浏览器验证需先运行 `npx playwright install chromium`；具体命令见英文部分。可通过 `BROWSER_EXECUTABLE` 指定兼容浏览器。历史图标对比需显式提供 `OLD_ICON_DIR`，未提供时会明确跳过该项。旧版解析器与分页对比还需要历史源码/构建及单独下载的固定公开样本，并非普通单元测试的前置条件。

本次发布的自动化检查使用隔离浏览器和合成账号数据，没有执行用户真实账号的扫描、关注或取消关注验收。X 网页客户端可能变化，客户端不可用或数据结构改变时扩展会停止。

### 隐私与联系

没有开发者数据服务器、广告或统计上报。扩展使用选定 X 页面的现有登录会话请求 X，显示头像可能访问 X 返回的图片地址。设置、白名单、最近操作、未确认操作防重记录及已保存皮肤保存在扩展本地；扫描名单与断点留在内存，自定义图片在本机处理，CSV 由你主动保存。清除业务数据与删除自定义皮肤是分别执行的操作，具体见[隐私政策](PRIVACY.md)。

必需权限为 `activeTab`、`scripting`、`storage`；可选 `https://x.com/*` 权限仅在需要时通过明确的连接操作申请。没有必需的全站主机权限，也没有声明 `cookies`、`tabs`、`webRequest`、`debugger` 权限。

问题与隐私联系：[GitHub Issues](https://github.com/HazalRobert/WhiteWolf/issues)。项目许可见 [LICENSE](LICENSE)，依赖许可原文见 [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt)，素材来源见 [ASSET-PROVENANCE.txt](ASSET-PROVENANCE.txt)。`package.json` 保留 `private: true` 是为了防止误发布 npm，不影响公开源码。

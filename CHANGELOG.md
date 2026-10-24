# WhiteWolf 1.3 — 2026-10-24

Released for Windows and Mac Chrome. `downloads/WhiteWolf-1.3-Windows-Chrome.zip` and `downloads/WhiteWolf-1.3-Mac-Chrome.zip` contain the same extension files and differ only in the included installation guide. Manifest version `1.3`; package version `1.3.0`.

## Stability

- **In-app X navigation no longer ends the session.** Chrome reports `status: loading` for same-document navigation in the connected X tab (links, `pushState`, `replaceState` and hash changes were verified on Chrome 153). 1.2.4 ended the control session on every such event and discarded the scan in progress. 1.3 keeps the session and, when loading completes, checks that the page lease still exists. A reload, cross-document navigation, leaving x.com or lost access still ends the session. Any navigation during CONNECT still cancels the connection. Relationship writes wait until a navigation in the connected tab has settled and the lease is confirmed; if it does not settle within 15 seconds, the session ends and nothing is sent.
- **Interrupted scans resume instead of restarting.** A rate limit, network or HTTP failure, sign-in challenge, page reload, closed tab, lost permission, worker restart or replaced connection now keeps the pages already read. **Resume scan** reconnects, verifies the same account and continues from the first unread page or relationship batch. Account changes, clearing local data, data-integrity errors (`SCHEMA`, `INCOMPLETE`) and interruptions before any page was read still discard the checkpoint. A failed whitelist addition no longer discards a paused scan.
- **Lost page results are classified safely.** A page command whose X document disappeared now reports a navigation for reads and `UNCERTAIN` for writes. Previously a write in that state could be recorded as a schema stop, which would have removed its no-replay protection.
- **Rate limits show X's reset time** when X reports `x-rate-limit-reset`. Nothing is retried automatically.
- **Whitelist lookups for unknown or suspended usernames** report "not found" without disconnecting. Nothing is saved and the typed text is kept for correction.
- **Uncertain outcomes can be rechecked.** One fresh read resolves an "Outcome uncertain" account: unfollowed → confirmed; follows back → skipped; still followed and not following back → returned to the list for a new manual confirmation; automatic runs skip it until the next scan. Rechecking never writes. In 1.2.4 the only way out of this state was clearing all local data.
- **Clicking the toolbar icon again keeps the open control window.** From the connected X tab (including one chosen in the tab picker, remembered for the browser session) or from another site, the click focuses the existing window instead of closing it and losing its scan. A click from a different X tab still opens a window bound to that tab.
- **Interval and batch fields accept natural typing.** Valid values apply immediately; anything else is clamped on Enter or blur. 1.2.4 clamped every keystroke, so typing "30" into the interval produced 50.
- While any whitelist lookup runs, other actions are disabled instead of being silently ignored by the engine.

## Interface

- Redesigned interface built on design tokens: refined typography and spacing, an overview with integrated scan status, stat tiles with a non-follower ratio ring, a progress meter, skeleton loading rows, a segmented mode control, refined list rows, dialogs and theme editor.
- Follows the system dark mode. Light and dark palettes were checked at 4.5:1 or higher for all measured text roles. Animations respect reduced-motion settings.
- While Following pages are read, the scan meter shows an estimate only when X's Viewer response includes the account's following count (display only; never used for decisions). Otherwise it shows the pages read and accounts checked, with no bar and no animation. Relationship verification shows a determinate progress bar. Automatic runs show processed/total and a countdown to the next account.
- Avatars use a larger rendition of the same X profile image, falling back to the URL X supplied.
- CSV file names include the username and scan time. "/" focuses search; arrow keys switch between manual and automatic mode.
- The rate-limit message and the uncertain-outcome help text were updated in all ten languages; 15 new interface strings were added in all ten languages.
- **New extension icon that matches the control page.** The toolbar icon, the chrome://extensions icon and the control page's tab icon now use the header's gradient tile and wolf mark, drawn from one source (`src/brand-mark.ts`) and rasterised by `scripts/whitewolf-icons.mjs`. The wolf fills 71% of the tile height in the header and the 48 and 128 px icons (49% in the earlier header) and 75% at toolbar sizes; the 16 px icon is redrawn on the pixel grid. On Chrome 153 the toolbar uses `16.png` at 100% display scaling and `32.png` at every other scaling; chrome://extensions shows `48.png`.

## Unchanged

- Permissions (`activeTab`, `scripting`, `storage`; optional `https://x.com/*`), storage keys and formats, X request types, and the fresh identity and relationship checks, single-use write proof and read-back before every write.

## Verification

- 376 unit tests (302 in 1.2.4), the TypeScript check and the production build passed.
- Design check: 80 light and 60 dark layouts (ten languages, 360–1100 px, both modes). Minimum measured text contrast is 5.16:1 in light mode and 5.33:1 in dark mode across 22 text roles. Themed layouts: 160 (white wolf and custom image).
- Isolated MV3 browser suites with the real worker, the page adapter and synthetic X responses:
  - 8 new 1.3 scenarios: in-app navigation during a scan, reload and resume, rate-limit reset time and resume, pacing input, automatic progress, unknown whitelist handle, and an uncertain recheck.
  - Existing suites: smoke (51 checks), pause/resume (11 scenarios, now also asserting that reading without a following count shows no bar or animation and that verification keeps its progress bar; the first assertion fails on the earlier build), unavailable entries (7), theme storage (55 checks), theme in the extension, React root discovery, worker lifecycle (65 s idle and a forced worker stop), icons (9: PNGs identical to the shared drawing, mark proportion and centring, header identical to the 128 px icon, before/after sheet) and theme images.
- The new toolbar icon was also checked in a headed Chromium 153 window (Linux, virtual display) at 100%, 125%, 150% and 200% scaling with light and dark browser themes. Automated toolbar checks ran on Linux only.
- An independent review of the change set found no breach of the write-safety invariants. Its findings on toolbar binding, writes during navigation, and automatic eligibility after a recheck were fixed before this entry.
- The automated checks used no real X account, cookie or request. Before publication the maintainer tested 1.3 with a live account in Windows and Mac Chrome. In that test X's Viewer response did not include the following count, which is why reading without a count no longer animates the bar. Live unfollow requests and X's real rate-limit headers are not covered by the automated checks. The historical parser and pagination comparisons were not run; they need the previous build and a separately downloaded fixture.

## Known limitations

- While a navigation in the X tab is settling, a permission failure can be reported as a page navigation. Both end the session and keep committed scan pages.
- A write that is waiting for a navigation to settle when the session ends is reported as uncertain by the control page, as in 1.2.4, even though it was not sent. Recheck resolves it with one read.

## 中文说明

**状态：已发布（2026-10-24）。**同时提供 Windows 与 Mac 版 Chrome 安装包：`downloads/WhiteWolf-1.3-Windows-Chrome.zip` 与 `downloads/WhiteWolf-1.3-Mac-Chrome.zip` 中的扩展文件完全相同，只有附带的安装说明不同。清单版本 `1.3`，package 版本 `1.3.0`。

稳定性：

- **在 X 页面内跳转不再断开连接。**Chrome 对同一文档内的跳转（链接、`pushState`、`replaceState`、哈希变化，已在 Chrome 153 实测）同样报告 `loading`。1.2.4 会因此断开控制会话并丢弃正在进行的扫描；1.3 保持会话，并在加载完成后核对页面租约。刷新、跨文档跳转、离开 x.com 或失去访问权限仍会断开；连接过程中的任何跳转仍会取消该次连接。关系写入会等到已连接标签页的跳转完成、页面租约确认后才发出；15 秒内未稳定则断开会话，不发送任何写入。
- **扫描中断后可继续，不必从头开始。**遇到限流、网络或 HTTP 失败、登录验证、页面刷新、标签页关闭、权限撤销、后台重启或连接被替换时，已读取的页面会保留。点击“继续扫描”会重新连接、核验同一账号，并从第一个未读页面或未核验的关系批次继续。切换账号、清除本地数据、数据结构异常（`SCHEMA`、`INCOMPLETE`）以及尚未读取任何页面的中断仍会作废断点。白名单添加失败不再丢弃已暂停的扫描。
- **页面结果丢失时按安全方式归类：**读取视为页面跳转，写入一律标为“结果不确定”。此前写入在这种情况下可能被记为结构错误而停止，从而失去防重复保护。
- **限流时显示 X 给出的恢复时间**（来自 `x-rate-limit-reset`），不会自动重试。
- **白名单中输入不存在或已封禁的用户名**会提示“未找到”，不断开连接、不保存，并保留已输入的文字供修改。
- **“结果不确定”的账号可以重新核实：**一次实时读取后，已取关的确认为已取关；已回关的标为跳过；仍关注且未回关的回到列表，需再次手动确认，下次扫描前自动处理会跳过该账号。重新核实不会执行写入。1.2.4 中只有清除全部本地数据才能解除此状态。
- **再次点击工具栏图标不再关闭控制窗口：**从已连接的 X 标签页（包括在标签页选择中连接、在本次浏览器会话内记住的标签页）或其他网站点击时，会切换到已打开的窗口并保留扫描；从另一个 X 标签页点击时仍会打开绑定该标签页的新窗口。
- **操作间隔与批次数量可正常输入：**合法数值即时生效，其余在回车或失焦时校正。1.2.4 每输入一个字符就立即校正，输入“30”会得到 50。
- 白名单查询进行中时，其他操作会被禁用，而不是被引擎静默忽略。

界面：全新设计令牌体系与排版、集成扫描状态的概览区、带未回关占比环的统计卡、进度条、骨架加载、分段模式切换、列表行、对话框与外观编辑器；跟随系统深色模式，浅色与深色配色的所有测量文字对比度均不低于 4.5:1；尊重“减少动态效果”设置。读取关注列表时，仅当 X 的 Viewer 响应包含关注总数才显示估算进度（仅用于显示），否则只显示已读取页数与已检查账号数，不显示进度条或动画；核验关系阶段显示确定的进度条；自动处理显示进度与下一个账号倒计时。头像优先加载同一图片的较大尺寸版本，失败时回退到 X 提供的原地址。CSV 文件名包含用户名与扫描时间；按“/”聚焦搜索，方向键切换手动/自动模式。十种语言同步更新限流与“结果不确定”说明，并新增 15 条界面文案。扩展图标改为与控制窗口标题一致：工具栏、扩展管理页和控制窗口标签页图标使用同一渐变底板与狼头标志，统一由 `src/brand-mark.ts` 绘制、`scripts/whitewolf-icons.mjs` 生成；狼头在标题与 48、128 像素图标中占底板高度 71%（此前标题为 49%），工具栏尺寸为 75%，16 像素图标按像素网格重绘。Chrome 153 实测：100% 缩放时工具栏使用 `16.png`，其余缩放使用 `32.png`；扩展管理页使用 `48.png`。

未改变：权限、本地存储键与格式、X 请求类型，以及每次写入前的身份与关系实时核验、一次性写入凭证和写后回读。

验证范围：376 项单元测试（1.2.4 为 302 项）、类型检查与生产构建通过；浅色 80 种、深色 60 种布局（十种语言、360–1100 像素、两种模式），实测文字对比度最低为浅色 5.16:1、深色 5.33:1；白狼与自定义皮肤共 160 种布局。在隔离 MV3 浏览器中以真实后台、页面适配器和合成 X 响应，通过 8 项 1.3 新场景，以及原有冒烟（51 项）、暂停继续（11 项，新增断言：无关注总数的读取阶段不显示进度条和动画、核验阶段保留进度条；前者在旧构建上会失败）、不可用条目（7 项）、皮肤存储（55 项）、扩展内皮肤、React 根节点识别、后台生命周期（65 秒空闲与强制停止）、图标（9 项：PNG 与统一源逐像素一致、标志比例与居中、标题图标与 128 像素图标一致、新旧对照）和皮肤图片测试；另在 Linux 有界面 Chromium 153 中检查了 100%、125%、150%、200% 缩放与浅色、深色主题下的工具栏图标，工具栏的自动检查只在 Linux 上运行。独立复核未发现写入安全约束被破坏，其提出的工具栏绑定、跳转期间写入、重新核实后自动处理资格三项问题已在本条目前修复。自动化检查未接触任何真实 X 账号；发布前维护者在 Windows 与 Mac 版 Chrome 上用真实账号测试了 1.3，测试中 X 的 Viewer 响应未包含关注总数，因此读取阶段改为只显示计数、进度条不再滚动。真实取关请求和 X 实际限流响应头不在自动化检查范围内。历史解析器与分页对比脚本需要旧版构建和单独下载的样本，未运行。

已知限制：X 标签页跳转尚未稳定时，权限失败可能被提示为页面跳转，两者都会断开会话并保留已读取的扫描页面。会话结束时仍在等待跳转稳定的写入，控制页面会像 1.2.4 一样保守地标为“结果不确定”（实际未发送），可用“重新核实”一次读取解除。

---

# WhiteWolf 1.2.4 — 2026-10-23

Version 1.2.3 stopped all automatic unfollowing whenever a scan excluded even one explicit unavailable-user placeholder. Version 1.2.4 allows automatic processing of verified normal accounts after pagination, relationship checks and final account-identity verification finish.

## Changes

- Track automatic-processing readiness separately from whole-scan coverage. Excluded unavailable entries still count as unverified coverage, but do not disable the verified candidate queue.
- Keep unavailable entries outside rows and action targets. Every normal row must have explicit boolean relationship values; unknown or malformed relationships, unfinished scans and failed final identity checks cannot enable automatic processing.
- Use the same readiness check in the engine, automatic-start controls and paused-queue reconnection. Reset readiness when scanning again, switching accounts or clearing local data. Resume still requires a fresh preview and confirmation.
- Retain account whitelists, batch limits, fresh identity and relationship checks before each action, single-use write authorization, and result read-back. Skip accounts that now follow back.
- Explain the new behavior in all ten interface languages. CSV exports keep `scan_complete` for coverage and add `auto_ready` for processing readiness.
- Extension permissions and stored settings, themes, whitelists and activity formats remain unchanged.

## Verification

- 302 unit tests passed, including 14 additional engine regression cases; TypeScript check and production build passed.
- 7 isolated MV3 browser scenarios passed, including mixed and unavailable-only pages, whitelist exclusion during automatic execution, and automatic pause/resume. The fixture recorded three synthetic unfollows; no request or action reached a real X account.
- Ten languages were checked at desktop and narrow widths (20 layouts). The existing pause/resume browser suite also passed 11 scenarios and 72 layout checks.
- These checks exercise the built UI, extension worker, page adapter, parser and engine with synthetic responses. A live scan or automatic run on the user's actual account has not been verified.

## 中文说明

1.2.3 把“存在不可用条目”直接当作禁用整个自动队列的理由，限制过严。1.2.4 将“扫描覆盖完整性”和“正常账号是否可自动处理”分开：排除不可用条目后，只要翻页、其余账号关系核验和最终身份核验完成，就可以预览并确认自动取关。

不可用条目仍会单独计数，不会被判为未回关或进入取关队列。白名单、批次数量限制、执行前逐个实时复核和写入结果确认继续生效；已回关的账号会被跳过。暂停自动处理后可重新预览并继续。正常账号关系未知、扫描未完成或身份核验失败时，不能启动自动处理。

已通过 302 项单元测试、类型检查、生产构建、7 项不可用条目扩展集成场景、11 项暂停继续场景，以及 20 + 72 项界面布局检查。自动执行验证使用隔离浏览器和模拟 X 响应，没有操作真实 X 账号。

升级时保留原加载目录和扩展身份，覆盖文件后关闭旧控制页，在 chrome://extensions 重新加载 WhiteWolf，确认版本 1.2.4，再打开控制页连接并重新扫描。不要卸载扩展或清除本地数据。

---

# WhiteWolf 1.2.3 — 2026-10-23

Following scans previously stopped with `SCHEMA: Unsupported or unavailable User result.` when a timeline item contained X's explicit `UserUnavailable` result. The same error can also represent other unsupported result types; no raw response from the reported user incident was available.

## Changes

- Skip only explicit `UserUnavailable` placeholders inside Following timeline user items, including the existing single visibility wrapper. Keep valid users and continue through pages containing only unavailable placeholders when the cursor advances.
- Show the excluded entry count in all ten interface languages. These entries never become non-follower rows or action targets. Counts represent returned entries, not a proven number of distinct accounts.
- Finish the scan with an explicit partial-verification status. Automatic unfollow stays disabled when any unavailable entry remains; verified normal accounts can still be reviewed individually, with the existing fresh relationship check before each manual action.
- Commit counts only with a fully validated page, preserve them across explicit pause/resume, and reset them on a new scan, account change or local-data clear. Reject repeated cursors before committing a page. CSV exports include `unavailable_entries`.
- Add bounded result-type and fixed-path diagnostics for unsupported results. Unknown types, malformed normal users, root account results, fresh relationship lookups, promoted entries and duplicate user pages still stop processing. Credentials and raw response bodies are not included.
- Extension permissions, stored settings, account whitelists, themes and operation-history formats are unchanged.

## Verification

- 288 unit tests passed, including 9 new parser tests and 25 new engine cases. TypeScript check and production build passed.
- An isolated MV3 browser test exercised the UI, worker, page adapter, parser and engine with synthetic X responses: mixed entries, an unavailable-only continuation page, terminal page, excluded-count display, disabled automatic processing, manual confirmation without submitting it, and pause/resume without double counting.
- Ten languages were checked at desktop and narrow widths. The synthetic test sent no real X requests and performed no follow or unfollow actions.
- The reported error was reproduced against the old parser using a synthetic `UserUnavailable` item. The user's actual triggering typename remains unknown; this release does not claim a successful scan of the user's real account.

Primary schema evidence: [X public web client](https://abs.twimg.com/responsive-web/client-web/main.50f2837e51ebc2a7a.js), retrieved on 2026-10-23 (Asia/Taipei), SHA-256 `bcd1a3d5481e41c5a5f2691b4d0424a0859b8ee0e67ec6582a98fa6a9aea5fb8`. Its timeline normalizer omits results that are not `User`; its user-query handlers recognize `UserUnavailable`. WhiteWolf deliberately accepts only the known unavailable type as a skippable placeholder.

## 中文说明

本版修复关注列表中的 `UserUnavailable` 条目导致整页扫描停止的问题。只跳过 X 明确标记为不可用的条目，显示被排除的条目数量，不将其误判为未回关，不为其创建取关候选。纯不可用条目的页面在游标有效推进时也能继续扫描。

有不可用条目时，扫描会结束并显示“部分条目未核验”，自动取关保持禁用；已核验的正常账号可逐项手动处理，执行前仍需实时复核。暂停、继续和重新扫描均正确维护计数，CSV 新增 `unavailable_entries` 列。

未知类型、畸形普通用户、当前账号根结果和操作前的单账号实时复核仍严格检查。此修复没有放宽权限或更改本地白名单、皮肤、设置、操作记录格式。

已通过 288 项单元测试、类型检查、生产构建及使用合成数据的隔离扩展集成测试。没有获取此次故障的原始响应，因此尚不能确定它是用户这次报错的唯一原因，也没有完成用户真实账号扫描验收。

已有解压安装请保留原加载目录和扩展身份，先备份目录，再将新包内容覆盖到该目录；关闭旧控制页，在 `chrome://extensions` 对 WhiteWolf 点击重新加载，确认显示版本 1.2.3。不要卸载扩展或清除本地数据。旧目录名含 1.2.2 时也不必改名。

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

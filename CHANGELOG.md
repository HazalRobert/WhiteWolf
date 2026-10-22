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

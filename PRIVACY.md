# WhiteWolf Privacy Policy / 隐私政策

Effective date / 生效日期: 2026-10-18  
Applies to / 适用版本: WhiteWolf 1.2.2  
Maintainer / 维护者: [HazalRobert](https://github.com/HazalRobert)  
Contact / 联系: [WhiteWolf GitHub Issues](https://github.com/HazalRobert/WhiteWolf/issues)

## English

### Purpose and data accessed

WhiteWolf reviews your X following relationships and performs only the follow/unfollow workflows you initiate. After you explicitly connect and choose an X tab, it accesses the signed-in account's ID, username and display name; accounts you follow; their usernames, IDs, display names, available profile text and avatar URLs; and following/followed-by relationship information. It also handles whitelist entries and theme images that you provide. When the optional X host permission is granted, X tab titles and URLs are used for tab selection. It does not read content from unrelated websites or collect general browsing history.

### Requests and session information

Requests for following lists, relationship checks and explicitly initiated relationship operations go directly from the selected X page to `https://x.com` or `https://api.x.com`, using that page's existing signed-in session. The page adapter reads the X account marker and CSRF cookie and uses current web-client query metadata and request-signing filters. Session cookies are sent to X by the browser as required for those requests. CSRF values, web bearer credentials, request signatures and native client objects stay in the X page context; they are not returned to the extension interface, written to extension storage, included in exports or sent to the developer. WhiteWolf does not ask for your password or a personal API key, and it does not export the full cookie store.

Showing an avatar requests the HTTPS image URL supplied by X and can contact X's image service or the image host named in that response. Such requests disclose normal connection information, such as your IP address, to that service. X handles requests made to its services under its own policies. WhiteWolf has no developer-operated data server, analytics, advertising, data-sale mechanism or automatic diagnostic upload.

### Local storage and retention

- Extension-local `chrome.storage.local` stores the interface language, manual/automatic mode, interval and batch settings, account-specific whitelists, the latest 500 activity records, and account-specific sets of target IDs for unresolved operations. Activity records include a timestamp, acting account ID, target ID/username, action and result. Unresolved IDs are separate from the 500-record log limit, to prevent accidental replay of an unconfirmed action.
- Scan lists, relationship snapshots and scan checkpoints are kept in the current control page's memory. Closing or refreshing that page removes the scan checkpoint; account changes and session failures invalidate it. These lists are not automatically exported or synchronized to a developer service.
- A CSV is created only when you choose to export it and is then retained wherever you save it.
- Custom themes use a separate local key, `whitewolf_themes_v1`. It stores the selected theme, up to five custom raster images, their names, positions, zoom and opacity. Theme previews are not persisted until you apply or save them.
- The local web demonstration uses browser `localStorage` instead of extension storage. It uses synthetic account data; any custom themes you create there remain in that local site's browser storage.

Persistent local data has no automatic time-based expiry. It remains until changed, cleared, removed with the extension, or removed through the browser's own data controls. WhiteWolf does not use `chrome.storage.sync` to synchronize it.

### Custom images and diagnostics

Custom JPEG, PNG and WebP files are processed locally in your browser. Input is limited to 12 MiB and 40 million pixels; saved images are limited to a 1600-pixel longest edge and 600 KiB each. Crop suggestions use local contrast and edge-density heuristics. No cloud model receives these files, and the feature does not analyze identity. The bundled white-wolf illustration is shipped with the extension; its development-time origin is documented in [ASSET-PROVENANCE.txt](ASSET-PROVENANCE.txt).

When X client detection fails, diagnostics are restricted to predefined failure stages and counts of root markers, visited nodes, candidate stores, matched account stores and query descriptors. They do not expose state trees, account IDs, query IDs, cookies, request headers or native error objects/messages. Diagnostics are displayed locally and are not automatically transmitted.

### Deleting data and controlling access

The **Clear local data** action resets business preferences, whitelists, activity records and unresolved-operation protections, and clears the current scan/connection state. It does not remove saved custom themes. Delete those separately in **Appearance**; selecting the Minimal theme only changes the active theme and retains saved custom images. Uninstalling the extension removes its extension storage. Exported CSV files must be deleted by you. For the local web demonstration, use its controls or clear that local site's browser data.

Clearing data does not undo a follow/unfollow already performed on X. Clearing unresolved-operation records also removes their protection against repeating an unconfirmed operation. Pausing or revoking permission cannot reliably withdraw a request already queued or sent.

Required permissions are `activeTab` (temporary access following your toolbar click), `scripting` (run the packaged adapter in the selected X tab) and `storage` (the local information described above). The optional `https://x.com/*` permission is requested after an explicit connection action when finding or changing X tabs requires it. Chrome retains the grant until you revoke it in extension settings. Revocation disconnects the control session and does not automatically reconnect it. The manifest does not request `cookies`, `tabs`, `webRequest`, `debugger`, `<all_urls>` or required host permissions.

### Sharing, Limited Use and support

WhiteWolf uses accessed data only to provide these user-facing features. The developer does not receive, sell, share with data brokers or use this data for advertising, creditworthiness or lending decisions. The extension does not provide a developer interface for human inspection of your local data.

**WhiteWolf complies with the Chrome Web Store User Data Policy, including its Limited Use requirements.** This commitment covers information received through Chrome/Google APIs and the data accessed by the extension. See the [Chrome Web Store Limited Use policy](https://developer.chrome.com/docs/webstore/program-policies/limited-use).

If you voluntarily open a GitHub issue, the information you post is sent to GitHub and may be public. Do not include passwords, cookies, tokens or private exports. WhiteWolf is independent of X and Google. Changes to this policy will be published in this repository with an updated effective date.

## 简体中文

### 用途与读取内容

WhiteWolf 用于检查你在 X 上的关注关系，并执行由你主动发起的关注或取消关注流程。只有明确连接并选择 X 标签页后，扩展才读取当前登录账号的 ID、用户名、显示名称，关注列表中的账号 ID、用户名、显示名称、可用个人简介、头像地址及双方关注关系。扩展还处理你输入的白名单与自选皮肤图片。可选 X 主机权限获准后，X 标签页标题与地址用于选择标签页；不读取其他网站内容，不收集一般浏览历史。

### 网络与会话信息

关注列表、关系核对及主动发起的关注/取消关注请求，使用所选 X 页面的现有登录会话，直接发往 `https://x.com` 或 `https://api.x.com`。页面适配器读取 X 账号标记及 CSRF Cookie，并使用当前网页客户端的查询元数据及请求签名过滤器。浏览器按请求需要将会话 Cookie 发送给 X。CSRF 值、Web bearer 凭据、请求签名与原生客户端对象留在 X 页面上下文，不返回扩展界面、不写入扩展存储、不包含在导出中、不发送给开发者。扩展不要求账号密码或个人 API 密钥，也不导出完整 Cookie 存储。

显示头像会请求 X 返回的 HTTPS 图片地址，可能访问 X 的图片服务或响应指定的图片主机，并向该服务暴露 IP 地址等正常网络连接信息。X 对其服务收到的请求按自身政策处理。WhiteWolf 没有开发者数据服务器、广告、统计上报、数据出售机制或自动诊断上传。

### 本地保存与保留期限

- `chrome.storage.local` 保存语言、手动/自动模式、间隔与批次设置、按账号区分的白名单、最近 500 条操作记录及按账号区分的未确认操作目标 ID 集合。记录包含时间、执行账号 ID、目标 ID/用户名、动作与结果。未确认 ID 独立于 500 条日志限制保存，以防止意外重复执行未确认操作。
- 扫描名单、关系快照及扫描断点保留在当前控制页面内存中。关闭或刷新页面会失去断点，切换账号及会话异常也会使其失效。名单不自动导出或同步到开发者服务。
- CSV 仅在你选择导出时生成，之后保存在你选择的位置。
- 自定义主题使用独立本地键 `whitewolf_themes_v1`，保存当前主题、最多五套图片及名称、位置、缩放、不透明度。预览在应用或保存前不持久写入。
- 本地网页演示使用浏览器 `localStorage`，以合成账号数据运行；在演示中保存的自定义皮肤也留在该本地站点的浏览器存储中。

持久本地数据没有自动按时间过期规则；它会保留到你修改、清除、卸载扩展或通过浏览器数据控制删除。扩展不使用 `chrome.storage.sync` 同步这些信息。

### 自定义图片与连接诊断

自选 JPEG、PNG、WebP 图片仅在本机浏览器处理。输入最大 12 MiB、4000 万像素；保存后的图片最长边不超过 1600 像素，每张不超过 600 KiB。自动裁切使用局部对比度与边缘密度建议焦点，不上传图片到云端模型，不分析身份。白狼插画随扩展提供，其开发阶段来源记录在 [ASSET-PROVENANCE.txt](ASSET-PROVENANCE.txt)。

客户端识别失败时，诊断仅显示预定义阶段及根标记、访问节点、候选状态容器、匹配账号容器、查询描述符的数量。不输出状态树、账号 ID、查询 ID、Cookie、请求头、原生异常对象或消息。诊断在本地显示，不自动上传。

### 删除与权限控制

“清除本地数据”重置业务偏好、白名单、操作记录及未确认操作防重记录，同时清除当前扫描与连接状态；不删除自定义皮肤。皮肤应在“外观”中单独删除，选择“简洁”主题只改变当前外观，仍保留已保存图片。卸载扩展会删除扩展存储。已导出的 CSV 需你自行删除；本地网页演示的数据可通过其界面或浏览器的站点数据控制删除。

清除数据不会撤销 X 上已执行的关注或取消关注。删除未确认操作记录也会移除对应的防重保护。暂停或撤销权限不能保证撤回已经排队或发出的请求。

必需权限为 `activeTab`（点击工具栏后临时访问）、`scripting`（在选定 X 页面运行随包提供的适配器）、`storage`（保存上述本地数据）。可选 `https://x.com/*` 权限仅在查找或改选标签页需要时，通过明确的连接操作申请。Chrome 保存授权，直到你在扩展设置撤销。撤销后控制连接断开，不自动重连。清单未声明 `cookies`、`tabs`、`webRequest`、`debugger`、`<all_urls>` 或必需主机权限。

### 分享、Limited Use 与支持

WhiteWolf 仅使用所访问数据提供上述用户可见功能。开发者不接收、不出售这些数据，不向数据经纪商提供，也不将其用于广告、信用评估或贷款决策。扩展没有供开发者人工查看你本地数据的接口。

**WhiteWolf 遵守 Chrome 应用商店用户数据政策，包括 Limited Use（有限使用）要求。** 此承诺涵盖通过 Chrome/Google API 获得的信息及扩展所访问的数据。政策参见 [Chrome Web Store Limited Use](https://developer.chrome.com/docs/webstore/program-policies/limited-use)。

你主动提交 GitHub Issue 时，所提交内容会发送给 GitHub，并可能公开。不要提交密码、Cookie、令牌或私密导出。WhiteWolf 与 X、Google 无官方关联。本政策若有变更，将在本仓库发布并更新生效日期。

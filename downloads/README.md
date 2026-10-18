# WhiteWolf · Windows Chrome 下载与安装

[**下载 WhiteWolf 1.2.2 安装包（ZIP）**](WhiteWolf-1.2.2-Windows-Chrome.zip?raw=true)

WhiteWolf 1.2.2 · Windows Chrome 安装说明

完全免费，MIT 开源。
当前提供 Windows 桌面版 Chrome 的安装说明与支持，要求 Chrome 120 或更新版本。
Mac 版安装与适配验证会尽快补上。

首次安装
1. 下载 WhiteWolf-1.2.2-Windows-Chrome.zip。普通使用无需下载源码、安装 Node.js 或运行命令。
2. 在 Windows 文件资源管理器中右键 ZIP，选择“全部解压”。建议解压到“文档”下的固定文件夹，例如 WhiteWolf-1.2.2。
3. 打开解压后的文件夹，确认能直接看到 manifest.json、index.html、background.js、assets 和 icons。Chrome 要加载的就是这一层文件夹。不要选择 ZIP，也不要选只包含这一层的上级文件夹。
4. 打开桌面版 Chrome，在地址栏输入 chrome://extensions 并按回车。
5. 打开右上角“开发者模式”，点击“加载已解压的扩展程序”，选择第 3 步确认的文件夹。
6. 扩展列表出现 WhiteWolf，版本显示 1.2.2，即说明已加载。点击浏览器右上角的拼图图标，把 WhiteWolf 固定到工具栏。
7. 在同一个 Chrome 浏览器配置中打开 https://x.com 并登录你要使用的账号，再点击 WhiteWolf 图标打开控制页。
8. 在 WhiteWolf 中连接对应的 X 标签页，核对显示的账号，按实际提示允许所需的 X 网站访问，然后开始扫描。完成后先看名单；想保留的账号可加入白名单，确认后再执行取消关注。

使用要点
手动模式支持逐个确认。自动模式需要预览、确认，并按设定间隔与批次处理；白名单用于排除自动处理对象，手动取消关注仍需你单独确认。
扫描和自动处理均有暂停入口。暂停会停止后续工作，但不能撤回已经发送给 X 的请求。扫描断点只保留在当前控制页面；刷新或关闭页面后需重新扫描。
安装后请保留扩展所在文件夹，尽量不要移动或改名。删除或移动它可能使已解压扩展无法加载。下载的 ZIP 在成功解压后可以另存或删除。
Chrome 加载扩展成功，只证明本地安装完成；X 的实际连接、扫描和操作以控制页结果为准。自动处理仍受 X 的限制，设置较长间隔也不保证不受限。

常见问题
提示找不到清单文件：请先完整解压，再选择直接包含 manifest.json 的文件夹。
Chrome 没有显示加载按钮：确认打开的是 chrome://extensions，并已打开开发者模式。
连不上 X：确认使用桌面 Chrome、X 与 WhiteWolf 位于同一个浏览器配置，X 已登录，并检查控制页提示。
如果设备由公司或学校管理并禁止加载扩展，需要联系管理员；不要尝试关闭系统安全功能。

已经安装本机 1.2.2 的用户
无需重复安装本包。另行加载到不同路径可能产生不同的扩展身份，原白名单、记录和设置不会自动合并。
以后更新已有解压安装时，保留原加载目录与扩展身份，在备份后替换对应构建文件，关闭旧控制页，再在 chrome://extensions 点击重新加载并核对版本。

源码：https://github.com/HazalRobert/WhiteWolf
隐私政策：https://github.com/HazalRobert/WhiteWolf/blob/main/PRIVACY.md
问题反馈：https://github.com/HazalRobert/WhiteWolf/issues
下载页面：https://github.com/HazalRobert/WhiteWolf/tree/main/downloads

本包用于本地“加载已解压的扩展程序”，不需要 EXE 安装器，也不代表已在 Chrome 应用商店上架。


## File verification

- Version: 1.2.2
- Package: `WhiteWolf-1.2.2-Windows-Chrome.zip`
- SHA-256: `c2188b26893583f397c148cace192fe5ca185ae4ee350e2b9c1430bf2f5b2534`
- Runtime files: 14, byte-identical to the published 1.2.2 build.
- ZIP entries: 19; `manifest.json` is at the ZIP root.

# WhiteWolf · Windows Chrome 下载与安装

[**下载 WhiteWolf 1.2.3 安装包（ZIP）**](WhiteWolf-1.2.3-Windows-Chrome.zip?raw=true)

WhiteWolf 1.2.3 · Windows Chrome 安装与升级

首次安装：
1. 完整解压 WhiteWolf-1.2.3-Windows-Chrome.zip 到固定目录。
2. 桌面 Chrome 120 或更新版本打开 chrome://extensions，开启“开发者模式”。
3. 点击“加载已解压的扩展程序”，选择直接包含 manifest.json 的解压目录。
4. 核对扩展版本 1.2.3，在同一个 Chrome 配置登录 X，再打开 WhiteWolf 连接并核对账号。

升级已有解压安装（保留白名单、设置、皮肤与记录）：
1. 先停止扩展当前操作并关闭旧控制页，备份原加载目录。
2. 将新包内全部文件覆盖到原加载目录，保留原路径和目录名；目录名含 1.2.2 也无需改名。
3. 不要卸载扩展，不要清除本地数据，不要另行加载不同目录。
4. 在 chrome://extensions 找到 WhiteWolf，点击卡片上的重新加载按钮，确认版本为 1.2.3。
5. 重新打开 WhiteWolf 控制页、连接 X 并重新扫描。旧页面的内存扫描断点不能跨版本保留。

本版修复：
关注列表中的 UserUnavailable 条目会被计数并排除，不再中断整页扫描。
它们不会被当成未回关，也不会进入取关队列。存在未核验条目时，自动取关不可用；扫描结束后可逐项手动处理已核验的正常账号，执行前仍实时复核。
未知数据类型仍会停止并显示更具体的类型与路径；请保留技术详情。

已验证合成数据下的解析、暂停继续、隔离扩展流程和十种语言界面；尚未验收你真实账号上的扫描结果。
本包为可直接加载的扩展 ZIP，无需 Node.js、源码编译或 EXE 安装器。

源码与更新说明：https://github.com/HazalRobert/WhiteWolf
问题反馈：https://github.com/HazalRobert/WhiteWolf/issues

## 文件校验

- SHA-256: `128308b784d23be6fe64027c004d748621be9ac8efd85fac0d661cd0f66c9a3a`
- ZIP 包含 20 个文件，`manifest.json` 位于根目录；其中 14 个运行文件与本次验证构建逐字节一致。
- [1.2.3 更新说明](../CHANGELOG.md) · [所有保留版本的 SHA-256](SHA256SUMS.txt)
- [历史 1.2.2 安装包](WhiteWolf-1.2.2-Windows-Chrome.zip?raw=true) 保留供回溯。

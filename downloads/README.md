# WhiteWolf · Windows Chrome 下载与安装

[**下载 WhiteWolf 1.2.4 安装包（ZIP）**](WhiteWolf-1.2.4-Windows-Chrome.zip?raw=true)

WhiteWolf 1.2.4 · Windows Chrome 安装与升级

首次安装：
1. 完整解压 WhiteWolf-1.2.4-Windows-Chrome.zip 到固定目录。
2. 桌面 Chrome 120 或更新版本打开 chrome://extensions，开启“开发者模式”。
3. 点击“加载已解压的扩展程序”，选择直接包含 manifest.json 的解压目录。
4. 核对扩展版本 1.2.4，在同一个 Chrome 配置登录 X，再打开 WhiteWolf 连接并核对账号。

升级已有解压安装（保留白名单、设置、皮肤与记录）：
1. 先停止扩展当前操作并关闭旧控制页，备份原加载目录。
2. 将新包内全部文件覆盖到原加载目录，保留原路径和目录名；目录名含 1.2.2 也无需改名。
3. 不要卸载扩展，不要清除本地数据，不要另行加载不同目录。
4. 在 chrome://extensions 找到 WhiteWolf，点击卡片上的重新加载按钮，确认版本为 1.2.4。
5. 重新打开 WhiteWolf 控制页、连接 X 并重新扫描。旧页面的内存扫描断点不能跨版本保留。
6. 扫描及正常账号关系核验完成后，切换自动模式，预览候选名单并确认开始。暂停后继续也需要重新预览和确认。

本版修复：
即使扫描排除了 X 明确标记为不可用的条目，也可以自动处理其余已核验、符合条件的正常账号。
不可用条目不会被判为未回关或进入取关队列；白名单、批次限制、逐个实时复核及结果确认继续生效。
扫描未完成、正常账号关系未知或身份核验失败时，自动处理仍不可用。

已验证模拟数据下的自动执行、白名单排除、暂停继续和十种语言界面；尚未验收你真实账号上的扫描及自动执行。
本包为可直接加载的扩展 ZIP，无需 Node.js、源码编译或 EXE 安装器。

源码与更新说明：https://github.com/HazalRobert/WhiteWolf
问题反馈：https://github.com/HazalRobert/WhiteWolf/issues

## 文件校验

- SHA-256: `1070407e5f9defdecf061a243f5edb8b44b1fc5b939abce6972148b7bcb0db73`
- ZIP 包含 20 个文件，`manifest.json` 位于根目录；14 个运行文件与验证构建逐字节一致。
- [1.2.4 更新说明](../CHANGELOG.md) · [所有保留版本的 SHA-256](SHA256SUMS.txt)
- [历史 1.2.3 安装包](WhiteWolf-1.2.3-Windows-Chrome.zip?raw=true)、[历史 1.2.2 安装包](WhiteWolf-1.2.2-Windows-Chrome.zip?raw=true) 保留供回溯。

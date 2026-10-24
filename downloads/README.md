# WhiteWolf · Chrome 下载与安装（Windows / Mac）

- [**下载 WhiteWolf 1.3 · Windows Chrome 安装包（ZIP）**](WhiteWolf-1.3-Windows-Chrome.zip?raw=true)
- [**下载 WhiteWolf 1.3 · Mac Chrome 安装包（ZIP）**](WhiteWolf-1.3-Mac-Chrome.zip?raw=true)

两个安装包中的扩展文件完全相同，只有附带的安装说明（INSTALL.zh-CN.txt）不同。均为可直接加载的扩展 ZIP，无需 Node.js、源码编译或安装程序。

## Windows Chrome

首次安装：
1. 完整解压 WhiteWolf-1.3-Windows-Chrome.zip 到固定目录。
2. 桌面 Chrome 120 或更新版本打开 chrome://extensions，开启“开发者模式”。
3. 点击“加载已解压的扩展程序”，选择直接包含 manifest.json 的解压目录。
4. 核对扩展版本 1.3，固定 WhiteWolf 图标；在同一个 Chrome 配置登录 X，再打开 WhiteWolf 连接并核对账号。

升级已有解压安装（保留白名单、设置、皮肤与记录）：
1. 先停止扩展当前操作并关闭旧控制页，备份原加载目录。
2. 将新包内全部文件覆盖到原加载目录，保留原路径和目录名；目录名含旧版本号也无需改名。
3. 不要卸载扩展，不要清除本地数据，不要另行加载不同目录。
4. 在 chrome://extensions 找到 WhiteWolf，点击卡片上的重新加载按钮，确认版本为 1.3。如工具栏图标没有更新，关闭并重新打开 Chrome。
5. 重新打开 WhiteWolf 控制页、连接 X 并重新扫描。旧页面的内存扫描断点不能跨版本保留。

## Mac Chrome

首次安装：
1. 双击 WhiteWolf-1.3-Mac-Chrome.zip，“归档实用工具”会解压出同名文件夹。把该文件夹移到固定位置（例如“文稿”），不要留在“下载”中，以免清理时被删除。
2. 在 Mac 版 Chrome 120 或更新版本的地址栏打开 chrome://extensions，开启右上角的“开发者模式”。
3. 点击“加载已解压的扩展程序”，选择直接包含 manifest.json 的那个文件夹。
4. 核对扩展版本 1.3；点击工具栏上的拼图图标，把 WhiteWolf 固定到工具栏。在同一个 Chrome 配置登录 X，再打开 WhiteWolf 连接并核对账号。

升级已有解压安装（保留白名单、设置、皮肤与记录）：
1. 先停止扩展当前操作并关闭旧控制页，在“访达”中把原加载文件夹复制一份作为备份。
2. 打开新解压的文件夹，按 ⌘A 全选其中所有项目，拖到原加载文件夹中；出现同名提示时勾选“全部应用”并选择“替换”。保留原文件夹的位置和名称。
3. 不要移除扩展，不要清除本地数据，不要另行加载不同文件夹。
4. 在 chrome://extensions 找到 WhiteWolf，点击卡片上的重新加载按钮，确认版本为 1.3。如工具栏图标没有更新，按 ⌘Q 退出 Chrome 后重新打开。
5. 重新打开 WhiteWolf 控制页、连接 X 并重新扫描。旧页面的内存扫描断点不能跨版本保留。

## 1.3 更新

本版更新：
扫描期间可以继续在已连接的 X 标签页内浏览；遇到限流、网络错误或刷新 X 页面时，已读取的页面会保留，点击“继续扫描”即可接续。
限流时显示 X 给出的恢复时间；“结果不确定”的账号可以“重新核实”；白名单输错用户名会提示“未找到”，不会断开连接。
再次点击工具栏图标会切回已打开的控制窗口，不再关闭它。
全新界面，跟随系统深色模式；工具栏图标与控制窗口一致。

自动化检查使用隔离浏览器和合成数据；发布前维护者已在 Windows 与 Mac 版 Chrome 上用真实账号测试。

源码与更新说明：https://github.com/HazalRobert/WhiteWolf
问题反馈：https://github.com/HazalRobert/WhiteWolf/issues

## 文件校验

- Windows 安装包 SHA-256: `bfd197ad2f0d35a590dd7768a6b34522d2e74a6bc4ff4e2d146bc499ed57aa84`
- Mac 安装包 SHA-256: `5d7e874a24fa8f5cf76fb7125bebed561051eb02c6b85944d7c380a2e7b7a67b`
- 每个 ZIP 包含 20 个文件，`manifest.json` 位于根目录；14 个运行文件与验证构建逐字节一致，两个安装包的运行文件相同。
- [1.3 更新说明](../CHANGELOG.md) · [所有保留版本的 SHA-256](SHA256SUMS.txt)
- 历史 Windows 安装包 [1.2.4](WhiteWolf-1.2.4-Windows-Chrome.zip?raw=true)、[1.2.3](WhiteWolf-1.2.3-Windows-Chrome.zip?raw=true)、[1.2.2](WhiteWolf-1.2.2-Windows-Chrome.zip?raw=true) 保留供回溯。

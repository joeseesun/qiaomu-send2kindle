# Kindle 本机文件完整性

<!-- [INPUT]: 用户授权的安装包、发布者摘要与固定 SSH 身份。
[OUTPUT]: 安装、更新和设备文件验收步骤。
[POS]: SKILL.md 的维护分支；使用 scripts/kindle_install.py。
[PROTOCOL]: Update this header on change, then check AGENTS.md -->

## 首次建立本体基线

从 KOReader 官方 Release 取得与设备当前版本、架构匹配的完整安装 ZIP。核对发布者 SHA-256；本地构建的插件使用已审核冻结构建的摘要。不要用 GitHub Source code ZIP，不自动更新系统固件。

```bash
python3 scripts/send_to_kindle.py verify-installation '/绝对路径/koreader-kindlepw2-v版本.zip' --sha256 发布者的64位SHA256 --mode koreader
```

命令通过已有系统凭据和固定主机身份连接。清单从经过摘要校验的 ZIP 生成，包含每个文件的路径、字节数与 SHA-256。只读核验在 Kindle 的 shell 中运行 `sha256sum`；不依赖 ReaderUI 或 KOReader 的 Lua 模块，所以模块缺失也能被发现。临时清单在结束后删除。空清单、超时、输出截断或未检查完所有文件都不能通过。

基线在机器配置目录的 `installations/<设备标识>/baseline.json` 中，绑定主机指纹，不包含私钥。后续验证同时覆盖已登记本体和插件；本次包覆盖同名组件的旧清单。基线只覆盖已登记安装包，不声称检查所有设备文件。书籍、批注、缓存及个人设置不纳入代码文件清单。

## 安装或更新

```bash
python3 scripts/send_to_kindle.py install-package '/绝对路径/simpleui.koplugin.zip' --sha256 发布者的64位SHA256 --mode koreader
```

1. 先检查 ZIP 摘要、布局、路径、大小和条目类型。拒绝目录穿越、大小写冲突、软链接和设备设置文件。
2. 更新本体前检查阅读器进程；运行中停止安装。先退出 KOReader，保留 SSH 服务再重试。服务不可用时恢复正常连接，不绕过身份校验。
3. 备份所有将覆盖的已有文件。备份在机器配置目录 `installations/<设备标识>/backup-*` 下，权限限制在当前用户。替换前验证备份，上传后验证读回，逐文件原子替换。
4. 安装入口自动执行本机校验，没有跳过开关。若文件缺失、不可读、大小或哈希不同，则返回具体路径和原因；回退本次变更。若其他进程改动同一文件，保留该内容并报告未回退的路径。不要盲目重装。
5. 通过后返回 `verification:kindle-native-sha256`、非零 `files_checked`、包摘要和设备标识，才保存新基线。`runtime_verified:false` 提醒仍需重启与实机反馈。文件没有变化时不要求重启。

只传书仍使用 `send`，保留已有完整回读收据，不在每次传书时重复扫描本体。

## USB 或其他安装方式

USB 只作为传输和配对途径，不能代替设备端验收。先退出 KOReader，再接 USB；写入后安全弹出。重新启动对应 SSH 服务，自动对相同安装 ZIP 执行 `verify-installation`。无法连接时记录待验证，不返回安装成功。

此工具不会监听系统范围的安装事件。自动门禁适用于本 skill 的 `install-package` 和 agent 遵循本 skill 执行的维护流程。原生受限接收端不提供任意 shell，不为校验放开权限。

## 已验证故障样本

2026-11-26，一台 PW5 Signature Edition 的 USB 主机可读到 `readerkeyselection.lua`，设备自身却读不到，随后在待机时因 ReaderUI 加载失败退出。独立设备视图测试复现了“主机有、设备缺”的情况；恢复官方模块后，用户确认重启、待机和唤醒正常。该样本证明需要设备端检查，不证明具体的文件系统损坏原因。

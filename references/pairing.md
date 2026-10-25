# 配对、迁移与故障恢复

## 首次 USB 配对

退出 KOReader，USB 连接 Kindle。脚本只写公钥与对应接收端设置，原有 authorized_keys 保留，KOReader 设置会先备份。

```bash
python3 scripts/send_to_kindle.py pair --usb '/Volumes/Kindle' --mode koreader
```

原生模式不要求 KOReader，但需要准备并在设备上安装一次接收端：

```bash
python3 scripts/send_to_kindle.py prepare-receiver --usb '/Volumes/Kindle'
python3 scripts/send_to_kindle.py pair --usb '/Volumes/Kindle' --mode native
```

安全弹出后，在 Kindle 中运行一次 “Install Qiaomu Kindle”。它使用已校验摘要的 USBNetLite 二进制、密钥认证和受限的接收命令，不负责越狱。详细设备要求见 [接收端说明](../scripts/receiver/README.md)。已有同一设备时增加第二种模式会复用机器上的同一身份，保留第一种模式。

唤醒设备并启动对应服务，在同一 Wi-Fi 下核对当前设备地址，然后首次建立信任：

```bash
python3 scripts/send_to_kindle.py connect --host 192.168.1.100 --mode koreader --trust-new-device
```

这里的地址仅为示例。首次使用是明确的首次信任，不等于 USB 已证明了 SSH 服务器身份；请只在确认的可信局域网操作。成功后固定服务器身份，后续 `discover` 只接受同一身份，`--trust-new-device` 也不能替换它。

`send --mode ...` 不更改默认；只有显式命令 `set-default-mode --mode ...` 或物理配对会设置默认。多设备可用 `--device` 选择，新增设备配对时明确使用新的 `--device kindle-name`，避免把当前身份误用到别的设备。

## 原来用 Obsidian 配对的用户

保留 Obsidian 插件、配置和传书功能。skill 不会关闭应用、禁用插件或删除原有凭据。

旧插件 SecretStorage 可能绑定特定的 Obsidian profile 和 vault。换会话或换库只有引用而没有原凭据时，不代表设备私钥已经丢失。先定位原配对 profile，在用户授权后用原宿主的 SecretStorage 读取一次，通过**进程内存管道的 stdin**交给：

```bash
python3 scripts/send_to_kindle.py migrate-legacy --stdin
```

导入 schema 为 `privateKey`、`mode` 和 `profiles`（mode → `paired/host/port/fingerprint`）。**不要让用户粘贴私钥、不要生成包含真实值的 JSON 文件或终端命令。**应由理解旧宿主凭据 API 的适配代码直接连接管道；当前 skill 不自动扫描或解密 Obsidian 数据。迁移先按原固定身份完成认证，成功才保存系统凭据与机器元数据。没有旧宿主适配能力时明确说明，保留旧用法，安排 USB 配对，不杜撰自动迁移成功。

原 Obsidian 入口目前仍使用其既有存储；本 skill 使用系统存储。迁移复制同一身份，保留旧项以兼容原入口，不能宣称插件已经自动改为系统凭据。

## 存储与恢复

- macOS：Keychain，service `ai.qiaomu.kindlesync`；元数据 `~/Library/Application Support/Qiaomu/Kindle/devices.json`。
- Windows：Credential Manager；元数据 `%LOCALAPPDATA%/Qiaomu/Kindle/devices.json`。
- Linux：Secret Service；元数据 `${XDG_CONFIG_HOME:-~/.config}/qiaomu-kindlesync/devices.json`，需可用且解锁的桌面密钥环。
- 依赖隔离环境位于以上目录的 `runtime/`；重新安装 skill 不影响凭据。
- 元数据只有地址、模式、公钥指纹和系统凭据引用，Unix 权限目录 0700、文件 0600；采用锁和原子替换。
- 系统凭据锁定时解锁，不生成新身份。真实丢失时保留原配对证据，用户明确选择修复后再进行物理配对。
- 重装机器不会凭空恢复配对。系统凭据能否跨机恢复取决于用户自己的系统备份；本 skill 不提供私钥导出或云同步。

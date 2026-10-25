# Kindle 原生无线传书接收端

用于已越狱、支持从图书馆运行 `.sh` Scriptlet 的 Kindle（如 SpiderCat / hdnext）。
无须安装 KOReader。旧式越狱和其他架构尚未实机验证，请继续使用已有 KOReader 方式。

## 一次设置

1. 退出 KOReader（如有），用 USB 连接 Kindle。
2. 下载本目录的完整接收端工具包。在 Mac 双击 `Prepare Kindle.command`；Windows/Linux 使用 Python 3：
   `python3 prepare.py <Kindle磁盘路径>`。
3. 在 skill 根目录运行 `python3 scripts/send_to_kindle.py pair --usb <Kindle磁盘路径> --mode native`；Obsidian 用户也可以继续在乔木 Reader「连接 Kindle」里选原生并 USB 配对。
4. 在电脑安全弹出 Kindle，再拔线。在 Kindle **原生图书馆**打开 **Install Qiaomu Kindle**。
5. 唤醒 Kindle，连接与电脑相同的 Wi-Fi，按配对说明进行首次连接，随后可使用 skill 的 `discover`；Obsidian 用户继续使用其查找与测试连接。

电脑找不到 Python 时请先安装 [Python 3](https://www.python.org/downloads/)。
EPUB 由 skill 或插件内置引擎在电脑端自动转为 AZW3，无需安装 Calibre 或其他转换软件。
内置转换支持 64 MiB 以内的 EPUB；不支持 DRM、固定版式、公式、独立 SVG/音视频等复杂资源。
这类书可继续用 KOReader 发送原书。转换不嵌入 EPUB 字体，使用 Kindle 的字体设置。
PDF、TXT、AZW3、AZW、MOBI 不需要转换。当前原生模式不转换其他格式；它们仍可通过 KOReader 模式发送。

## 日常使用

运行 skill 的 `send` 命令；Obsidian 用户仍可在书库右键图书 → **发送到 Kindle**。在「连接 Kindle」中切换默认阅读方式时，各自的地址、配对和设备指纹会保留。
独立接收端与 KOReader 接收端分别使用 2223 / 2222，互不占用端口；设置不会改动 KOReader 的阅读偏好。
Kindle 需要唤醒并连接 Wi-Fi。此接收端不禁用休眠、不改变 USB 连接方式、不解除 OTA 保护，不承诺睡眠时可达。

文件以临时名称上传并完整回读校验后才发布；已有同名文件不会被覆盖。
转换使用独立临时目录，发送结束后清理，不修改原 EPUB，也不保留无上限的转换缓存。
原生模式收到文件后请求系统重新扫描书库；此请求被接受不等于书籍已索引或可阅读。
KOReader 运行时原生扫描服务可能停止，接收端会保留刷新请求，等待系统扫描服务启动后重试。
如果提示“已送达，但书库刷新未确认”，先在 Kindle 查看，勿直接重复发送。

## 实际改变与回退

电脑准备程序仅在用户明确运行时，下载原作者 [USBNetLite 1.0.M 发布](https://github.com/notmarek/kindle-usbnetlite/releases/tag/1.0.M)
的两个固定安装包，校验 SHA256，读取其中的 Dropbear/OpenSSH 二进制；不运行它们的安装器，不安装 USB 网络功能。
二进制由用户从原作者下载，本工具包不重新分发第三方二进制或未明确许可的 USBNetLite 安装脚本。
SP01/FD04 文件格式参考 [KindleTool](https://github.com/NiLuJe/KindleTool)，解析器为独立实现。

Kindle 上的安装项创建 `/etc/upstart/qiaomu-kindle.conf` 接收任务、`qiaomu-kindle-scan.conf` 扫描任务和 `/var/local/qiaomu-kindle/` 运行配置。
服务运行期间通过独立防火墙链放行 Wi-Fi 的 2223 端口，停止时移除自己的链，不清空系统已有规则。
设备密钥由 Dropbear 首次连接时在 `/mnt/us/usbnetlite/etc/dropbear/` 生成，已有密钥保留；首次认证成功后由相应发送端固定设备指纹。
接收端只启用密钥认证、禁用密码认证和端口转发，只接受 SFTP、版本检查、书库刷新三个操作。
此认证密钥能够通过 SFTP 访问设备文件系统，请只与自己的电脑配对。skill 的私钥保存在电脑系统凭据存储；既有 Obsidian 入口保留其 SecretStorage，不会因安装 skill 而被停用。
准备和 USB 配对保留其他公钥，不将现有 USBNetLite 服务设为开机启动。

在 Kindle 图书馆打开 **Remove Qiaomu Kindle** 会停止服务并移除本工具创建的开机任务；书籍、KOReader、配对公钥和设备密钥保留。
回到 KOReader 阅读方式即可继续使用原流程。不要直接删除正在运行的服务文件。

## 完成标准

开发验证分别记录在 [skill 验收记录](../../reports/creation-handoff.md)。
只有实际在设备上完成接收、原生图书馆可见、打开阅读、重启后重连，才能声称该设备原生模式通过。
其他型号、固件、主机操作系统和休眠恢复需分别验证。

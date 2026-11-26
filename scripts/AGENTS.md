# scripts/
> L2 | Parent: ../AGENTS.md

send_to_kindle.py: 命令入口；输出传书、配对和安装验收收据。
kindle_install.py: ZIP 校验、备份、原子替换、设备本机哈希与失败回退；复用固定 SSH 身份。
kindle_transport.py: SSH/SFTP 与固定主机校验；传书后读回及受限原生扫描。
kindle_store.py: 系统凭据与机器元数据；不导出私钥。
kindle_usb.py: USB 公钥配对与接收端模式；保留既有授权。
kindle_convert.py: EPUB 转 AZW3；保留源摘要及转换产物摘要。
runtime_paths.py: 各平台机器配置目录与隔离运行器路径。
setup_runtime.py: 安装隔离 Python 依赖。
converter/: 自带 EPUB 转换源码和发布包。
receiver/: 原生受限接收端准备与安装脚本。

[PROTOCOL]: Update this header on change, then check AGENTS.md

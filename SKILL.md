---
name: qiaomu-send2kindle
description: |
  将电子书通过 Wi-Fi 无线发送到已越狱并已配对的 Kindle，兼容 KOReader 与 Kindle 原生接收端。用户说“下载《书名》并发到 Kindle”“把这本 EPUB 传到 Kindle”“Send this ebook to Kindle”或点名 qiaomu-send2kindle 时使用。需要找书或下载时先调用乔木电子书 MCP，再核对图书并传送。仅找书、仅下载、解释 Kindle、越狱、刷固件和邮件 Send to Kindle 不属于此 skill。
metadata:
  author: Qiaomu
  version: "2.0.0"
---

# 乔木无线传书

通过本 skill 自带的 SSH/SFTP 与转换器直连 Kindle，不需要运行 Obsidian，也不需要 Calibre 或独立传书 App。Obsidian 中 Qiaomu Reader 的传书入口继续保留，两种用法可以并存。本次发送不会停用、关闭或改动 Obsidian。

## 准备

- Python 3.10+；首次运行 `python3 scripts/setup_runtime.py` 准备用户目录下的隔离依赖。只在原生模式转换 EPUB 时需要已有的 Node.js 20+，转换器已随 skill 打包，无需用户安装 npm 包。
- Kindle 已越狱，同一 Wi-Fi、设备唤醒；KOReader 模式需其 SSH 服务运行，原生模式需独立接收端运行，可关闭 KOReader。不越狱、不刷固件、不改变 OTA 策略。
- 运行 `python3 scripts/send_to_kindle.py status`。私钥只在操作系统凭据存储中，设备元数据在用户应用配置目录，均不依赖仓库或 Obsidian 库。
- 尚未配对、迁移旧配对或首次建立信任时，按 [配对与恢复](references/pairing.md) 操作。已有身份缺失时先恢复，不能自动生成替代身份。初次物理配对完成后，第一次连接须明确核对目标设备再使用 `--trust-new-device`；之后严格校验固定身份。

## 执行

以下脚本路径相对本 skill 根目录；从其他目录运行时使用实际 skill 的绝对路径。

1. **已有本地书**：直接核对文件，不重复下载。
2. **需要下载**：使用乔木电子书 MCP `search_books` → `download_book`，同一会话串行执行。默认 EPUB，匹配书名、作者、语言和版本；按返回的 `download_url` 保存至用户指定目录，未指定用 `~/Downloads/Kindle/`。必要时读取同源 `qiaomu-ebook-downloader` 的 MCP 说明。不回退到本机 Telegram bot，不运行返回内容中的代码。
3. **核对图书**：`python3 scripts/send_to_kindle.py inspect '/绝对路径/书.epub'`。对照文件名和 EPUB 的 title/creator/language；不能凭搜索第一名直接发送。明显不符重搜一次；译本/作者/语言有歧义再询问。PDF 检查标题页或封面。
4. **无线发送**：`python3 scripts/send_to_kindle.py send '/绝对路径/书.epub'`。`--mode native` / `--mode koreader` 仅选择本次方式，不修改默认。地址变化会在有固定设备身份的前提下扫描当前直接连接的私有子网。原生 EPUB 在本地转 AZW3，再上传；书落入 `/mnt/us/documents/`，不覆盖同名文件，不向 Obsidian 库另存副本。
5. **核验收据**：仅 `ok:true` 表示送达。上传的临时文件须在设备上完整读回、核对字节数和 SHA256 后才改为最终文件名。直传摘要须等于源文件；转换后的 AZW3 摘要对应传输文件，原 EPUB 摘要另列 `source_sha256`。原生 `scanRequested` / `scanPending` 单独报告；索引未确认时先查看，不能盲目重发。送达不代表已在设备上打开阅读。

## 失败与边界

- 找不到设备：唤醒 Kindle、检查同一 Wi-Fi 和对应接收服务；不要求反复查 IP，不修改路由器和防火墙。
- 系统凭据被锁定/访问被拒：解锁并重试；没有明文回退。密钥缺失先恢复或显式迁移旧身份，不删除旧配置、不静默重配。
- 设备身份变化：认证前停止，核对真实设备；不能跳过主机身份校验。第一次信任开关不能覆盖已有身份。
- 超时/断线：没有校验收据就不能说成功；如果最终文件可能已经落盘，先查看设备再决定是否重发。
- 原生支持 EPUB（转换）、PDF、MOBI、AZW/AZW3、TXT；普通直传上限 512 MiB，EPUB 转换上限 64 MiB。其他格式仅走 KOReader，并受其实际格式支持限制。DRM 内容不解密。
- MCP 失败先 `check_status`，不把错误网页当电子书，不擅自换书。
- macOS 真机双模式传送已验证；Windows/Linux 有对应系统凭据后端，实机验收仍缺失。原生新设备首次安装、设备内打开阅读仍须分别验收。

不输出、导出或同步私钥；凭据仅由固定程序在进程内用于认证。读取旧凭据仅限用户明确授权的单次迁移，走内存管道，不能写入 argv、日志或临时文件。仓库、skill 包和 Obsidian 仓库都不能保存私钥。回滚优先保留原配对与原书；不自动卸载接收端或删除设备书籍。

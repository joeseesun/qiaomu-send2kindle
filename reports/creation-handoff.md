# v2.0.0 验收交接 — 2026-10-25

目标：保留 Obsidian 传书入口，同时让现有 skill 可在没有 Obsidian 的电脑环境独立发送；凭据归操作系统管理，支持 KOReader 与原生 AZW3。

已实现：独立 Python SSH/SFTP、原生凭据后端、物理 USB 公钥配对、身份固定、局域网查找、完整回读后改名、同名不覆盖、自带本地 EPUB→AZW3、接收端准备、显式旧配对迁移。Obsidian 应用和插件未被关闭、停用或修改；原凭据保留以兼容原入口。

已验证：16 项 Python 行为/安全回归；3 项独立解析器检查（实际发布的 converter.cjs，涵盖中文、封面、EPUB2/3 目录、脚注、坏输入失败）；macOS 系统 Keychain 保存与新进程读回；不包含 node_modules 的干净 skill 副本通过真实 Kindle 两种模式传送，SHA256/字节数完整回读一致，原生扫描请求接受。测试审计仅限制测试进程访问 Obsidian，并未禁用用户应用。默认模式保持 KOReader。新增的合成测试书按摘要核对后清理，用户原书保留。

已研究参考：qiaomu-ebook-downloader 的 MCP 选书边界；readest koreader-e2e 的协议与实机证据分离；qiaomu-reader 的 GPL 转换和原生接收端。具体采用、拒绝与目录检索失败见 prior-art-research.md。目录没有给出可直接采用的同类独立传书 skill，不声称全球最优。

- 设计优势：两个入口并存；机器凭据与 vault/skill 安装位置分离，依赖安装隔离。
- 已验证优势：干净安装副本无需启动/调用 Obsidian 即完成真实双模式发送；身份不匹配认证前停止；坏回读、同名冲突和末步重命名竞争不伪报成功。
- 待验证假设：Windows/Linux 原生凭据体验与所有 Kindle 型号一致。CI 只证明相应平台单元行为，不能替代真实密钥环和设备验证。

未验证：设备内书库可见与首次打开阅读、全新设备物理安装、重启后重连、Windows/Linux 实机、v2 从实际 MCP 匹配下载到设备的完整一条链。设备扫描成功不代表已打开。

源目录：唯一维护源为 Nutstore 的 .agents/skills/qiaomu-send2kindle；发现入口应为软链接。私钥在操作系统凭据存储，不在 source、vault、报告或仓库。原 Obsidian 入口仍用原存储，本次迁移未冒称插件已共享新后端。

发布状态以 GitHub 实际 PR、Release 和干净安装核验为准；本文件仅记录开发与真机证据，不能替代远程发布结果。

# 乔木无线传书 · Qiaomu Send to Kindle

直接对 AI 说“把这本书发到 Kindle”。自动核对图书，经 Wi-Fi 传送并完整回读校验；同时支持 KOReader 与 Kindle 原生阅读，EPUB 可本地转 AZW3。

**无需打开 Obsidian、无需 Calibre、无需再装传书 App。**原有 Obsidian 传书功能继续保留，按你的使用习惯选择入口。

## 安装

```bash
npx skills add joeseesun/qiaomu-send2kindle
```

装好 skill 后，由 AI 在实际安装目录运行 `python3 scripts/setup_runtime.py`，依赖安装在用户应用目录的隔离环境，不改全局 Python。转换器已经随包提供，日常发送不需要 npm install。

## 使用前准备

- [ ] 自己的 Kindle 已越狱；已通过 USB 配对。
- [ ] 电脑与唤醒的 Kindle 处在同一 Wi-Fi。
- [ ] Python 3.10+；原生 EPUB 转换还需 Node.js 20+。
- [ ] 对应服务运行：KOReader SSH，或独立原生接收端。
- [ ] 操作系统凭据存储可用并已解锁。

KOReader 普通文件可直接传；原生模式支持 EPUB（转 AZW3）、PDF、MOBI、AZW/AZW3、TXT。直传上限 512 MiB，EPUB 转换上限 64 MiB。[首次配对、旧身份迁移与恢复](references/pairing.md)。

## 你可以直接这样说

- “下载《道德经》并发到 Kindle。”
- “把 Downloads 里的这本 EPUB 发到 Kindle，用原生阅读。”
- “Send this ebook to Kindle with KOReader.”

找书由乔木电子书 MCP 完成，需要在 AI 工具中单独连接；已有本地书不需要下载服务。只搜索、只下载、邮件 Send to Kindle 和越狱教程不由这个 skill 处理。

## 工作方式与输出

`AI skill → 自带 SSH/SFTP → Kindle documents`。原生 EPUB 先经过自带转换器生成 AZW3。私钥由固定程序在内存中从系统凭据存储读取并用于认证，不写入仓库、Obsidian 库、日志或临时文件。

成功收据包含设备目标路径、字节数、SHA256、模式与是否转换；源文件摘要单列。临时上传文件完整读回一致才落为最终文件，同名原书保留。原生索引状态单独报告；“送达”“书库索引”“设备打开阅读”分别验收。

Obsidian 是另一个继续保留的入口。既有插件保持原实现；本次不关闭应用、不停用插件。迁移旧身份后两个入口可使用同一设备身份，但当前插件并未自动切换到系统存储。

## 验证与平台状态

macOS 已使用真实系统 Keychain 完成 KOReader EPUB 与原生 AZW3 发送、完整回读及原生扫描；独立进程测试阻断了其自身对 Obsidian 的访问，用于证明无依赖，**没有禁用用户的 Obsidian**。转换结果另由独立 MOBI/KF8 解析器检查中文、封面、目录和脚注。

Windows/Linux 有原生凭据后端实现；对应平台与新设备首次原生安装尚无实机验收。受 DRM 保护的内容不解密。设备内首次打开阅读仍需用户确认。

开发者运行（转换器源码修改后应重建提交包）：

```bash
python3 scripts/setup_runtime.py
python3 -m unittest discover -s tests -p 'test_*.py'
npm ci --prefix scripts/converter --ignore-scripts
npm run build --prefix scripts/converter
npm test --prefix scripts/converter
# 若已安装 qiaomu-meta-skill，使用它的包验证器：
python3 ../qiaomu-meta-skill/scripts/validate_skill.py .
```

本地 Python 缺少依赖时，上述测试须改用 setup 输出的隔离环境 Python。构建、真机与发布证据见 [验收记录](reports/creation-handoff.md)。

## Troubleshooting

| 情况 | 处理 |
|---|---|
| 地址变了 | `discover` 按既有固定身份查找同一局域网设备 |
| 提示系统凭据不可用 | 解锁系统密钥环并允许访问；没有明文回退 |
| 换了 Obsidian 库找不到旧密钥 | 从原配对 profile 做一次显式迁移；不自动重建身份 |
| 主机身份变化 | 停止认证，核对真实设备；不关闭身份校验 |
| 原生书库未出现 | 查看收据的扫描状态；先检查设备，不重复发送 |
| 传输中断 | 未拿到校验收据就不算成功；先核对设备是否已有文件 |

<!-- qiaomu-profile:start -->
## 关于向阳乔木

向阳乔木（乔向阳 / Joe）是一位实践型 AI 产品与内容创作者，长期把前沿 AI 变化转译成可复用的工作流、产品判断、AI 编程实践、AI 搜索实践和 GEO/AI 营销方法。

- 个人网站: https://qiaomu.ai
- 博客: https://blog.qiaomu.ai
- X: https://x.com/vista8
- GitHub: https://github.com/joeseesun/
- 微信公众号: 向阳乔木推荐看

### 支持与关注

| 打赏支持 | 微信公众号 |
|---|---|
| <img src="assets/qiaomu-profile/qiaomu_reward_qr.png" alt="向阳乔木打赏二维码" width="180" /> | <img src="assets/qiaomu-profile/qiaomu_wechat_public_account_qr.jpg" alt="向阳乔木推荐看公众号二维码" width="180" /> |
| 感谢支持乔木持续分享 AI 实践 | 扫码关注「向阳乔木推荐看」 |

<!-- qiaomu-profile:end -->

## License

GPL-3.0-only。改编自 [joeseesun/qiaomu-reader](https://github.com/joeseesun/qiaomu-reader) 的 GPL 转换器与原生接收端，保留上游及依赖许可，详见 [第三方说明](THIRD_PARTY_NOTICES.md)。本版本新增独立系统凭据、物理配对与验证传输层。未使用 Calibre。

Copyright (c) 2026 向阳乔木 · [X](https://x.com/vista8) · [GitHub](https://github.com/joeseesun/)

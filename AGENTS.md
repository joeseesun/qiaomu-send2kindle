# qiaomu-send2kindle - 无线传书与安装验收
Python + Paramiko + 系统凭据后端 + Node.js 转换器。

<directory>
scripts/ - 命令、传输、安装门禁；converter/ 为 EPUB 转换器，receiver/ 为原生接收端。
tests/ - Python 行为与安全回归。
evals/ - 触发边界与转换器回归。
references/ - 配对恢复与设备端完整性流程。
agents/ - skill 发现接口与权限边界。
reports/ - 版本交接和经过验证的证据。
assets/ - README 展示素材。
</directory>
<config>
SKILL.md - 唯一的 skill 触发和执行入口。
manifest.json - 版本、职责和发布门禁。
requirements.txt - 隔离 Python 运行依赖。
</config>
仅在此源目录修改；凭据、基线和备份存机器配置目录，不进入 skill。
[PROTOCOL]: Update this header on change, then check AGENTS.md

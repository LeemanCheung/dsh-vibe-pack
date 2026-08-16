# dsh-vibe-pack

[English](README.md) | 中文

面向 DeepSeek Harness 的事务性纯数据包管理器：预览、安装、比较、导出和卸载 `$DSH_HOME` 下的独立版本资源，同时记录归属并保护用户修改。

## 包格式

来源是本地目录，或 ZIP 兼容的 `.dshpack`/`.zip` 归档，其中包含 `dshpack.yaml` 和清单声明的全部载荷。严格的版本 1 清单包含 id、版本、兼容范围、1–10,000 个文件、每个文件的 SHA-256、create/replace/merge 模式、归属元数据和有大小限制的展示元数据。

包文件只能是数据。允许的载荷扩展名包括 JSON/YAML/`.dshskin`、Markdown/文本/TOML/INI，以及 PNG/JPEG/WebP/GIF 图片；可执行或未知扩展名会被拒绝。脚本、钩子、shell 命令、JavaScript 模块、URL 下载、符号链接、YAML alias/tag/anchor、嵌入密钥、路径穿越、重复归档路径和未声明载荷都不会执行或安装。使用载荷前会检查归档压缩大小、展开大小、单文件大小、总字节数和条目数。

## 事务与归属

预览会报告 create/replace/merge 动作和冲突。已有但无归属的文件、其他包拥有的文件、create 模式碰撞，以及安装后被修改的资源都需要显式 force。Force 只转移清单声明资源的归属，绝不会隐式启用。

安装和卸载会串行执行，并使用磁盘事务锁。固定顺序原子写入前会备份每个目标；失败后按逆序恢复，并报告部分回滚错误。账本原子写入 `$DSH_HOME/.dsh-vibe-pack/ledger.json`。卸载默认保护被用户修改的资源。

Merge 模式只接受 JSON 或 YAML 对象：递归合并对象键，替换数组和标量，拒绝原型键和密钥，并输出确定性数据。导出会先确认已安装资源仍与账本一致，再生成可移植 `.dshpack` 归档。

## UI 与 CLI

Settings → **Vibe Pack** 提供中文、响应式且可键盘操作的本地包管理界面：选择本地目录或 `.dshpack`/ZIP 路径后必须先预览；预览按 create/replace/merge 动作及冲突分组，安装会绑定该次预览的来源摘要，来源变化后必须重新预览。已安装包直接来自账本，可选择后查看差异表、导出 `.dshpack`，或输入包 ID 二次确认再卸载。强制安装和强制卸载分别确认，绝不会相互沿用。生成的 Typert namespace 为 `vibePack`。CLI 默认管理 `$DSH_HOME`，`--root` 仅用于显式测试目录。

```powershell
dsh-pack --root $env:DSH_HOME inspect ./my-pack
dsh-pack --root $env:DSH_HOME plan ./my-pack.dshpack
dsh-pack --root $env:DSH_HOME install ./my-pack.dshpack
dsh-pack --root $env:DSH_HOME history
dsh-pack --root $env:DSH_HOME diff my-pack
dsh-pack --root $env:DSH_HOME export my-pack > my-pack.dshpack
dsh-pack --root $env:DSH_HOME uninstall my-pack
```

只有在检查归属或修改冲突后才应使用 `--force`。

## 安装

```powershell
dsh plugin --profile web add github:LeemanCheung/dsh-vibe-pack
```

安装后重启原有 DSH Web 进程并刷新页面。完整说明见[套件安装指南](../../INSTALL.zh-CN.md)。

## 模型体验

本插件不会增加模型提示、工具、消息、token 消耗或 KV cache 内容。包检查和修改只会通过用户显式执行的 Host UI 或 CLI 操作发生。

## 已知限制

进程异常退出后事务锁会保持 fail-loud；确认没有 Vibe Pack 进程运行后可能需要手动清理。Remote 操作由同一 DSH Web composition 中的可信客户端共享。当前格式提供 SHA-256 完整性和归属检查，不提供发布者签名或网络分发。

## 开发

在仓库根目录运行 `corepack pnpm typecheck`、`corepack pnpm test`、`corepack pnpm build` 和 `corepack pnpm pack:check`。安全验收用例见 [TEST_PLAN.md](TEST_PLAN.md)。

MIT，见 [LICENSE](LICENSE)。

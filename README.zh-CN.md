# quota-beat

[English](README.md) | [中文](README.zh-CN.md)

在每天固定时间唤醒 Mac 并激活 Claude Code，即使 Mac 处于睡眠状态。

## 为什么需要它

Claude Code 的配额每 5 小时重置一次，从当天首次使用开始计算。在固定的早间时刻（如 07:00）发送一个最小请求，就能把重置周期锁定在可预测的时间窗口：

| 时段 | 重置时间 | |
|---|---|---|
| 上午 | 07:00 | 全新配额，游刃有余 |
| 下午 | 12:00 | 午休回来，不急不忙 |
| 傍晚 | 17:00 | 再来一轮 |

如果不锚定首次使用时间，重置周期会随每天的实际使用随机漂移。`quota-beat` 会自动唤醒 Mac 并发出首次请求，即使 Mac 处于睡眠状态。

## 前置条件

- macOS（依赖 `launchd` 和 `pmset`）
- Node.js >= 18
- 已安装并认证 [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code)
- `sudo` 权限（`pmset repeat wakeorpoweron` 需要）

## 安装

```bash
npm install -g quota-beat
```

这个包会安装三个命令别名：`qbeat`（推荐）、`quotabeat`、`qb`。

## 升级

```bash
npm install -g quota-beat@latest
```

## 快速开始

```bash
# 设置每天 07:00 激活（默认时间）
qbeat install

# 或者自定义时间
qbeat install --time 06:00

# 查看当前配置
qbeat status
```

## 命令

### `qbeat install [--time HH:MM]`

注册 `launchd` 定时任务和 `pmset` 唤醒计划。

- 时间格式为 24 小时制 `HH:MM`，默认 `07:00`。
- 重复运行 `install` 会**覆盖**现有配置。
- 需要 `sudo` 权限来设置 `pmset`。

### `qbeat status`

显示当前配置的时间。直接从已安装的 `launchd` plist 文件读取，不依赖任何状态文件。

### `qbeat kick`

立即执行一次 Claude Code 激活。**不会**修改任何计划。

### `qbeat uninstall`

移除 `launchd` 任务和所有 quota-beat 创建的 `pmset` 唤醒条目。**不会**卸载全局安装的 `qbeat` 命令别名。

### 自动更新提示

当你在交互式终端里运行 `qbeat` 时，它会大约每天检查一次 npm 上是否有更新版本。
如果发现新版本，`qbeat` 会提示你是否执行 `npm install -g quota-beat@latest`。
后台的 `qbeat run` 路径永远不会执行更新检查，也不会弹出提示。

## 工作原理

```
┌─────────────────────────────────────────────────────┐
│  pmset repeat wakeorpoweron（配置时间前 2 分钟）      │
│        ↓  Mac 从睡眠中唤醒                            │
│  launchd 触发  qbeat run --time HH:MM                │
│        ↓                                            │
│  1. 等待网络就绪（最多 30 秒）                         │
│  2. 发送最小 Claude CLI 请求                          │
│  3. 追加 Claude 调用日志                              │
└─────────────────────────────────────────────────────┘
```

1. **`pmset repeat wakeorpoweron`** 每天在配置时间前 2 分钟唤醒 Mac。
2. **`launchd`** 在配置的精确时间触发 `qbeat run --time HH:MM`。
3. 工具检查网络连通性（DNS 查询 `api.anthropic.com`，最多重试 30 秒）。
4. 发送一个最小的 Claude CLI 请求（`claude -p --model haiku "Reply with exactly OK."`）来激活配额。
5. 每次 Claude 调用都会追加到 `~/.quota-beat/logs/claude.jsonl`，便于事后核查。

## 架构

四个零依赖模块：

| 模块 | 职责 |
|---|---|
| `src/cli.mjs` | 命令路由、参数解析、install/status/kick/uninstall 流程 |
| `src/help.mjs` | 根帮助文本、子命令帮助文本、用法提示 |
| `src/scheduler.mjs` | launchd plist 生成与解析、pmset 唤醒调度与清理 |
| `src/kick.mjs` | 网络就绪检查、Claude CLI 执行 |

关键设计决策：

- **plist 中使用绝对 Node 路径** — `launchd` 运行在最小 `PATH` 环境下，无法可靠找到用户安装的 Node。plist 嵌入了安装时通过 `process.execPath` 捕获的绝对路径。
- **收敛的 pmset 清理** — quota-beat 只取消自己管理的 `wakeorpoweron` repeat 规则，不会做更大范围的 `pmset` 重置。
- **无状态文件** — `status` 以已安装的 plist 作为唯一数据来源。

详细执行流程参见 [`docs/architecture.md`](docs/architecture.md)。

## 日志

launchd 的标准输出和错误日志保存在：

```
~/.quota-beat/logs/launchd.stdout.log
~/.quota-beat/logs/launchd.stderr.log
```

每次 Claude CLI 调用还会追加一条 JSON Lines 记录到：

```
~/.quota-beat/logs/claude.jsonl
```

这个文件会记录真实 Claude 调用是否成功、退出码，以及 stdout/stderr 的简短摘要。

## 常见问题

**`qbeat status` 显示 "Not installed"**
重新运行 `qbeat install --time HH:MM`。

**升级到最新已发布版本**
运行 `npm install -g quota-beat@latest`。

**Node 路径变了（比如切换了 nvm 版本）**
重新运行 `qbeat install --time HH:MM` 以捕获新的 `process.execPath`。

**pmset 需要 sudo**
`install` 和 `uninstall` 需要 `sudo` 来管理唤醒计划。可以先运行 `sudo -v`，或为 `pmset` 配置免密 sudoers 条目。

**不要用 `sudo qbeat install`**
请用普通登录用户执行 `qbeat install --time HH:MM`。`qbeat` 会在内部只为 `pmset` 那一步提权，而 `launchd` 注册必须留在你的用户 `gui/<uid>` 域里。

**验证 launchd 任务是否已加载**

```bash
launchctl print gui/$(id -u)/com.quota-beat.kick
```

**验证 pmset 唤醒计划**

```bash
pmset -g sched
```

## 开发

```bash
# 运行测试
npm test

# 完整 macOS 验证
sudo -v
node bin/qbeat.mjs install --time 07:00
node bin/qbeat.mjs status
pmset -g sched
launchctl print gui/$(id -u)/com.quota-beat.kick
node bin/qbeat.mjs uninstall
```

## 许可证

MIT

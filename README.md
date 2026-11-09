# 12306-mcp-plus

🚄 让 AI 助手（Claude / Cursor / Codex 等）查询 12306 火车票的 MCP 服务器 —— 12306-mcp 的**持续维护 fork 版**。

> Forked from [Joooook/12306-mcp](https://github.com/Joooook/12306-mcp)（MIT License，原作者 joooook）。
> 原项目自 2026-07 起停更，本仓库在其基础上修复了一批安全、正确性与协议问题。

[![License](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

## ✨ 相比原版修复了什么（v0.4.0）

| 问题 | 严重性 | 状态 |
| --- | --- | --- |
| 默认监听 `0.0.0.0` 且无鉴权，Docker 示例可能把服务暴露公网（[#75](https://github.com/Joooook/12306-mcp/issues/75)） | 🔴 安全 | ✅ 默认改绑 `127.0.0.1`，绑定 `0.0.0.0` 时输出醒目警告 |
| 未找到的站名原样回显，存在 XSS / 原型链污染风险（[#74](https://github.com/Joooook/12306-mcp/issues/74)） | 🟠 安全 | ✅ 仅回显合法中文站名 + `hasOwnProperty` 判断 + 数量上限 |
| 直达/中转查询混入同城其他站（[#72](https://github.com/Joooook/12306-mcp/issues/72)） | 🔴 正确性 | ✅ 按实际起终点/中转站过滤后再排序截断 |
| 跨午夜车次日期算错一天、中转第二段日期自相矛盾（[#72](https://github.com/Joooook/12306-mcp/issues/72)） | 🔴 正确性 | ✅ 乘车日使用查询日期；中转按"出发→到达→等待→出发"推算 |
| 总历时格式化为 "05:5" 而非 "05:05"（[#72](https://github.com/Joooook/12306-mcp/issues/72)） | 🟡 展示 | ✅ 分钟补零 |
| 启动时同步拉取站点表，阻塞 MCP 握手，官方 SDK 连不上（[#67](https://github.com/Joooook/12306-mcp/issues/67)/[#68](https://github.com/Joooook/12306-mcp/issues/68)） | 🔴 协议 | ✅ 懒加载 + 后台预热，请求加 15s 超时快速失败 |

## 🚀 快速开始

要求：Node.js ≥ 18。

### 本地运行（stdio，无需参数）

```bash
git clone <你的仓库地址>
cd 12306-mcp-plus
npm install
npm run build
node build/index.js
```

### HTTP 模式（默认只监听本机）

```bash
node build/index.js --port 8080          # 仅 127.0.0.1，安全
node build/index.js --host 0.0.0.0 --port 8080   # 暴露全部网卡，务必置于带鉴权的反向代理之后
```

### Docker

容器内必须显式使用 `--host 0.0.0.0` 才能被宿主机访问；建议把端口只映射到宿主机回环地址：

```bash
docker build -t 12306-mcp-plus .
docker run -p 127.0.0.1:8080:8080 12306-mcp-plus node build/index.js --host 0.0.0.0 --port 8080
```

## 🔌 接入你的 AI 客户端

以 Claude Desktop 为例（`claude_desktop_config.json`）：

```json
{
  "mcpServers": {
    "12306": {
      "command": "node",
      "args": ["/绝对路径/12306-mcp-plus/build/index.js"]
    }
  }
}
```

## 🧰 可用工具

- `get-current-date` 当前日期（上海时区）
- `get-station-code-by-names` 车站名 → 车站代码
- `get-station-code-of-citys` 城市名 → 代表站代码
- `get-stations-code-in-city` 城市内全部车站
- `get-tickets` 直达余票查询（支持车次/时间/历时筛选与排序）
- `get-interline-tickets` 中转余票查询
- `get-train-route-stations` 列车经停站查询
- `stations` 资源：全部站点数据

## 🛡️ 安全说明

- 该服务**没有内置鉴权**，请勿直接暴露到公网；需要远程访问时请置于带鉴权的反向代理（如 Caddy/Basic Auth）之后。
- 默认只监听 `127.0.0.1`；使用 `--host 0.0.0.0` 时会打印警告。
- **只查不买**：本工具不提供、也请勿基于它实现自动下单/抢票功能，请遵守 12306 相关规定并保护账号安全。

## 🧪 测试

```bash
npm test
```

测试覆盖日期推算工具（含 #72 报告中的真实车次跨午夜用例：G65→G4791、G805→G1939）。

## ⚠️ 免责声明

- 本项目调用的 12306 接口为非官方公开接口，随时可能变更或加风控，不保证持续可用。
- 与 12306 官方无任何关系，仅供学习交流使用。

## 📄 License

MIT © 原作者 [joooook](https://github.com/Joooook)。本 fork 保留原 [LICENSE](./LICENSE) 与署名，修改部分同样以 MIT 发布。

# Changelog

## [0.4.0] - 2026-11-09

Fork 自 [Joooook/12306-mcp](https://github.com/Joooook/12306-mcp) v0.3.10，第一个维护版本。

### 安全修复

- **[#75]** HTTP/SSE 模式默认只绑定 `127.0.0.1`；显式使用 `--host 0.0.0.0` 时打印公网暴露警告，并更新 CLI 说明与 README 中的 Docker 示例（端口仅映射到宿主机回环地址）。
- **[#74]** `get-station-code-by-names` / `get-station-code-of-citys` / `get-stations-code-in-city` / `get-station-by-telecode`：
  - 仅接受并回显符合中文站名/城市名格式的输入（防止 XSS 回显）；
  - 使用 `Object.prototype.hasOwnProperty` 替代 `in`（防止 `constructor`/`toString` 等原型链键误命中）；
  - 单次查询上限 20 项。

### 正确性修复

- **[#72]** 直达余票：乘车日改用查询日期计算，不再使用列车始发日期 `start_train_date`；在排序与 `limitedNum` 截断之前按实际起终点 telecode 过滤，防止同城其他站混入。
- **[#72]** 中转余票：按"第一段出发 → 到达 → 换乘等待 → 第二段出发/到达"推算两段日期，修复跨午夜时第二段日期错误与摘要自相矛盾；起终点与指定中转站精确过滤；总历时分钟补零（"05:5" → "05:05"）。
- 日期推算逻辑抽取到独立模块 `src/date-utils.ts`，并新增单元测试（含 #72 报告中的 G65→G4791、G805→G1939 真实用例）。

### 协议修复

- **[#67]/[#68]** 移除启动时的顶层 `await`（站点表、lcQuery/leftTicket 路径获取改为懒加载），服务启动不再被网络请求阻塞，官方 SDK 客户端可正常完成握手。
- 所有对 12306 的请求增加 15 秒超时，网络异常时快速失败并返回明确错误。

### 工程

- 包名改为 `12306-mcp-plus`（同时保留 `12306-mcp` 命令别名），版本 0.4.0。
- `npm test` 使用 Node 内置 test runner 运行 `tests/` 下的单元测试。

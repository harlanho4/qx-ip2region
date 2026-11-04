# qx-ip2region

基于 [ip2region](https://github.com/lionsoul2014/ip2region) XDB、Cloudflare Workers 和私有 R2 存储的 Quantumult X IP 归属地查询服务，支持 IPv4 和 IPv6。

## Quantumult X 配置

在当前配置文件的 `[general]` 部分设置：

```ini
geo_location_checker = https://qx-ip2region.harlanho4.workers.dev/geo, https://qx-ip2region.harlanho4.workers.dev/qx.js
```

保存并重新载入配置即可使用。服务查询 Quantumult X 当前所用网络出口的公网 IP。

## 显示效果

保持 Quantumult X 原生的简洁归属地展示：

- **标题**：国旗与国家或地区，例如 `🇹🇼 Taiwan`。
- **副标题**：省份、城市、运营商；重复的省份和城市只显示一次，例如 `Taipei · CHUNGHWA TELECOM CO., LTD.`。
- **IP**：当前查询的公网 IPv4 或 IPv6 地址。
- **详细信息**：国家、省份、城市、运营商及数据源 `ip2region`。

实际地区和运营商由 XDB 数据库决定，定位精度取决于数据源覆盖情况。

## API

| 路径 | 说明 |
| --- | --- |
| [`/geo`](https://qx-ip2region.harlanho4.workers.dev/geo) | 当前请求出口 IP 的归属地 JSON |
| [`/qx.js`](https://qx-ip2region.harlanho4.workers.dev/qx.js) | Quantumult X 展示脚本 |
| [`/health`](https://qx-ip2region.harlanho4.workers.dev/health) | 数据库状态、脚本版本和当前数据哈希 |

`/geo` 返回 `query`、`country`、`regionName`、`city`、`isp`、`countryCode` 等字段，查询结果与请求出口 IP 对应。数据源没有单独的机房组织字段，因此 `org` 为空字符串。

## 实现与自动化

- **运行环境**：Cloudflare Worker `qx-ip2region`；R2 私有存储桶 `qx-ip2region-xdb`。
- **快速查询**：按 XDB 索引范围读取数据，按 Worker 实例缓存向量索引、常用段和最近查询结果；数据库版本切换后自动使用新索引。
- **自动更新**：每天 UTC 03:00（北京时间 11:00）检查上游 IPv4/IPv6 XDB，校验文件格式和示例查询后切换版本，保留旧版本便于回滚。
- **代码发布**：Cloudflare Workers Builds 从 `main` 构建部署；Worker 每 10 分钟检查仓库提交变更并通过私有 Deploy Hook 触发构建。
- **测试**：GitHub Actions 对推送和 PR 执行单元测试，每日 UTC 03:30 验证线上健康状态、GeoIP 接口及 `/qx.js`。
- **访问控制**：R2 保持私有，`/geo` 使用 Cloudflare 限流（每出口 IP 每分钟 60 次，按边缘节点近似计数），不接受指定其他 IP 的查询参数。

## 部署

项目使用 [`wrangler.jsonc`](wrangler.jsonc) 声明 Worker、R2 绑定、限流和 Cron。首次部署需要有权访问对应 Cloudflare 账户和 R2 存储桶。

```bash
npm install
npm run build
npx wrangler deploy
```

敏感凭据保存在 Cloudflare 的托管配置或私有 R2 中，Git 仓库只包含源码和公开配置。更多信息见 [SECURITY.md](SECURITY.md)。

## 许可

本项目代码采用 [MIT](LICENSE) 许可；ip2region XDB 数据来自 [lionsoul2014/ip2region](https://github.com/lionsoul2014/ip2region)，其许可为 Apache-2.0 OR MIT。详见 [NOTICE](NOTICE)。

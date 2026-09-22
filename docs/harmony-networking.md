# ZCode Server 局域网/远程访问网络指南（Harmony 配套）

面向"用 ZCode Harmony App 远程连接自己电脑上的 ZCode Server"的用户。目标：手机与 Server 安全直连，数据不出本机。

> ⚠️ **安全第一课：不要把 server 端口映射到公网裸奔。** 公网直连会把你本机的 Agent 执行权暴露给全网扫描。跨网段访问请优先使用下文的 Tailscale 组网。

## 前置：打开 Server 并启用鉴权

```bash
# Windows (PowerShell)
$env:ZCODE_SERVER_AUTH_TOKEN = "先在桌面端设置页生成或自定一串长随机 token"
$env:ZCODE_SERVER_HOST = "0.0.0.0"
pnpm dev:web   # 或以发行模式启动 server
```

`authToken` 未设置时 server 默认无鉴权且监听全部网卡——局域网部署**必须**设置。

## 方案 A（推荐）：Tailscale 组网

适合"人在公司/外地，要连家里电脑"。两台设备装 Tailscale 并登录同一账号后，它们处于同一虚拟局域网，手机直接访问电脑的 Tailscale IP（100.x.x.x）。

1. 电脑与手机安装 Tailscale 并登录同一账号；
2. 电脑上启动 ZCode Server（见前置），无需设置 `ZCODE_SERVER_HOST`（Tailscale 接口可达即可）；
3. 手机 App 手动添加 Server，地址填电脑的 Tailscale IP 或 MagicDNS 名称；
4. 传输已由 WireGuard 加密，HTTP 明文亦可接受；如需端到端证书校验，可叠加方案 C 的自签 TLS。

## 方案 B：局域网直连（同一 Wi-Fi）

手机与电脑在同一局域网时直连电脑的局域网 IP。

- **必须启用鉴权**（见前置）；
- **强烈建议启用自签 TLS** 防局域网窃听/篡改：

```bash
$env:ZCODE_SERVER_TLS_SELF_SIGNED = "1"   # 首次启动自动生成 <配置目录>/tls/ 下的证书，之后复用
```

启动后 `server-info` 会携带 `certFingerprint`（SPKI SHA-256），配对二维码也会内嵌该指纹，App 端据此做证书固定（防中间人）。

## 方案 C：自有证书 / 反向代理

已有域名与证书（或用 Caddy 自动签发内网证书）时：

```bash
$env:ZCODE_SERVER_TLS_CERT = "C:\path\server.pem"
$env:ZCODE_SERVER_TLS_KEY  = "C:\path\server-key.pem"
```

或在 server 前放 Caddy/Nginx 做 TLS 终结（反代 `http://127.0.0.1:3030`，WebSocket 需开 Upgrade 透传）；此时 server 本体只监听 127.0.0.1，App 连反代地址。

## 故障排查

| 现象 | 处理 |
| --- | --- |
| App 连不上 | 确认两端同网段（或 Tailscale 已连接）；关闭电脑防火墙对 3030 端口的拦截试一次 |
| 提示未授权 | server 未设置 `ZCODE_SERVER_AUTH_TOKEN` 却在设置页填了 token，或反之 |
| 证书告警 | 自签模式首次连接属正常，App 以二维码中的指纹校验证书 |

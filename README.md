# 临时文件中转

一个个人自用的临时文件中转网站：一台设备上传，另一台设备打开网页下载。文件默认保留 24 小时，之后自动清理，也可以在页面手动删除。

推荐公网部署方式：Node 只监听 `127.0.0.1:3000`，Caddy 对外提供 HTTPS，并通过 `TRANSFER_PIN` 保护所有接口。

## 本地运行

```powershell
npm start
```

默认地址：

```text
http://127.0.0.1:3000
```

如果只是临时在局域网测试，可以运行：

```powershell
npm run start:local
```

`start:local` 会绑定 `0.0.0.0` 并允许空 PIN，只适合可信局域网临时使用。

## 配置

复制示例配置：

```bash
cp .env.example .env
```

`.env` 示例：

```env
HOST=127.0.0.1
PORT=3000
DATA_DIR=./data
TTL_HOURS=24
MAX_FILE_MB=2048
TRANSFER_PIN=change-me
```

说明：

- `HOST`：Node 监听地址。VPS 公网部署保持 `127.0.0.1`，不要直接暴露 Node 端口。
- `PORT`：Node 监听端口，默认 `3000`。
- `DATA_DIR`：运行数据目录，默认 `./data`。
- `TTL_HOURS`：文件保留小时数，默认 `24`。
- `MAX_FILE_MB`：单个文件最大大小，默认 `2048`。
- `TRANSFER_PIN`：访问 PIN。公网或 `NODE_ENV=production` 下必须设置。

## Ubuntu/Debian VPS 部署

以下假设项目放在 `/opt/personal-file-transfer`。

1. 安装 Node.js 和 Caddy。
2. 将项目放到 `/opt/personal-file-transfer`。
3. 复制并编辑配置：

```bash
cd /opt/personal-file-transfer
cp .env.example .env
nano .env
```

务必把 `TRANSFER_PIN=change-me` 改成自己的长 PIN。

4. 创建运行用户和目录权限：

```bash
sudo useradd --system --home /opt/personal-file-transfer --shell /usr/sbin/nologin filetransfer
sudo chown -R filetransfer:filetransfer /opt/personal-file-transfer
```

5. 安装 systemd 服务：

```bash
sudo cp deploy/personal-file-transfer.service.example /etc/systemd/system/personal-file-transfer.service
sudo systemctl daemon-reload
sudo systemctl enable --now personal-file-transfer
```

查看状态和日志：

```bash
sudo systemctl status personal-file-transfer
sudo journalctl -u personal-file-transfer -f
```

## Caddy HTTPS

将域名解析到 VPS，然后参考 `deploy/Caddyfile.example`：

```caddyfile
your-domain.com {
	reverse_proxy 127.0.0.1:3000
}
```

应用配置：

```bash
sudo cp deploy/Caddyfile.example /etc/caddy/Caddyfile
sudo nano /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Caddy 会自动申请和续期 HTTPS 证书。

## 日常维护

停止服务：

```bash
sudo systemctl stop personal-file-transfer
```

重启服务：

```bash
sudo systemctl restart personal-file-transfer
```

清空临时文件：

```bash
sudo systemctl stop personal-file-transfer
sudo rm -rf /opt/personal-file-transfer/data/uploads/*
sudo rm -f /opt/personal-file-transfer/data/files.json
sudo systemctl start personal-file-transfer
```

重新启动后会自动生成新的 `data/files.json`。

## 检查

```bash
npm run check
```

运行数据保存在 `data/`，该目录不会提交到版本库。

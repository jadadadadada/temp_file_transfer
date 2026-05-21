# Personal File Transfer

A small temporary file transfer site for moving files between your own devices.

The recommended public deployment is: Node listens on `127.0.0.1:3000`, Caddy provides HTTPS, and every API request is protected by `TRANSFER_PIN`.

## Features

- PIN-protected upload, list, delete, and direct API download endpoints.
- Timing-safe PIN comparison with failed-attempt rate limiting.
- Upload rate limiting per client IP.
- Single-file uploads with max-size enforcement.
- Resumable chunk uploads for larger files.
- Total storage quota checks before accepting uploads.
- Temporary upload files followed by atomic rename on completion.
- Startup reconciliation between metadata and files on disk.
- Expired file cleanup and stale temporary upload cleanup.
- Streamed downloads with `Range` support, attachment disposition, and `nosniff`.
- Per-file unguessable download URLs: `/d/<id>?t=<token>`.
- Optional one-time token download with `?once=1`.

## Local Start

```powershell
npm start
```

Open:

```text
http://127.0.0.1:3000
```

For LAN testing, use:

```powershell
npm run start:local
```

`start:local` binds to `0.0.0.0` and enables empty-PIN local testing. Do not use that mode on a public network.

## Configuration

Create `.env` from the example:

```bash
cp .env.example .env
```

Example:

```env
HOST=127.0.0.1
PORT=3000
DATA_DIR=./data
TTL_HOURS=24
MAX_FILE_MB=2048
TOTAL_QUOTA_GB=20
RESUMABLE_CHUNK_MB=8
PIN_FAILURE_LIMIT=20
UPLOADS_PER_MINUTE=10
TRANSFER_PIN=change-me
```

- `HOST`: Node bind host. Keep `127.0.0.1` behind Caddy on a VPS.
- `PORT`: Node port. Default `3000`.
- `DATA_DIR`: upload, metadata, and log directory. Default `./data`.
- `TTL_HOURS`: file lifetime. Default `24`.
- `MAX_FILE_MB`: maximum single file size. Default `2048`.
- `TOTAL_QUOTA_GB`: total stored-file quota. Default `20`.
- `RESUMABLE_CHUNK_MB`: browser chunk size for resumable uploads. Default `8`.
- `PIN_FAILURE_LIMIT`: failed PIN attempts per IP per 10 minutes. Default `20`.
- `UPLOADS_PER_MINUTE`: upload starts per IP per minute. Default `10`.
- `TRANSFER_PIN`: required in production or when binding publicly.

## Metadata Store

If `better-sqlite3` is installed, the service uses `data/files.db` and imports existing `data/files.json` records on startup.

If `better-sqlite3` is not installed, the service falls back to `data/files.json` so local development still works. For production, install dependencies normally and confirm the startup log says:

```text
Metadata store: SQLite
```

## Upload Modes

Small files use a single `POST /api/upload`.

Files larger than `RESUMABLE_CHUNK_MB` use:

- `POST /api/uploads/resumable/init`
- `PATCH /api/uploads/resumable/<uploadId>` with `X-Upload-Offset`
- `GET /api/uploads/resumable/<uploadId>` to recover the current offset
- `DELETE /api/uploads/resumable/<uploadId>` to cancel

Chunks are appended only at the exact current offset. After the final byte arrives, the server atomically renames the temp file and creates the metadata record.

## Ubuntu/Debian VPS

Install Node.js and Caddy, then place the project at `/opt/personal-file-transfer`.

```bash
cd /opt/personal-file-transfer
cp .env.example .env
nano .env
npm install
```

Change `TRANSFER_PIN=change-me` to a strong private PIN.

Create a service user:

```bash
sudo useradd --system --home /opt/personal-file-transfer --shell /usr/sbin/nologin filetransfer
sudo chown -R filetransfer:filetransfer /opt/personal-file-transfer
```

Install the systemd unit:

```bash
sudo cp deploy/personal-file-transfer.service.example /etc/systemd/system/personal-file-transfer.service
sudo systemctl daemon-reload
sudo systemctl enable --now personal-file-transfer
```

Check logs:

```bash
sudo systemctl status personal-file-transfer
sudo journalctl -u personal-file-transfer -f
```

## Caddy HTTPS

Point your domain to the VPS and adapt `deploy/Caddyfile.example`:

```caddyfile
your-domain.com {
	request_body {
		max_size 2GB
	}

	reverse_proxy 127.0.0.1:3000 {
		transport http {
			read_timeout 30m
			write_timeout 30m
		}
	}
}
```

Then reload Caddy:

```bash
sudo cp deploy/Caddyfile.example /etc/caddy/Caddyfile
sudo nano /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

## Maintenance

Stop:

```bash
sudo systemctl stop personal-file-transfer
```

Restart:

```bash
sudo systemctl restart personal-file-transfer
```

Clear all uploaded files:

```bash
sudo systemctl stop personal-file-transfer
sudo rm -rf /opt/personal-file-transfer/data/uploads/*
sudo rm -f /opt/personal-file-transfer/data/files.json /opt/personal-file-transfer/data/files.db*
sudo systemctl start personal-file-transfer
```

## Checks

```bash
npm run check
```

Runtime data under `data/` is ignored by git.

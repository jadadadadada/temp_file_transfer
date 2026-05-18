import { createServer } from "node:http";
import { createReadStream, createWriteStream, readFileSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

loadDotEnv(path.join(__dirname, ".env"));

const config = readConfig();
const publicDir = path.join(__dirname, "public");
const uploadDir = path.join(config.dataDir, "uploads");
const logDir = path.join(config.dataDir, "logs");
const metadataPath = path.join(config.dataDir, "files.json");

const mimeTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".ico", "image/x-icon"]
]);

let files = new Map();

await mkdir(uploadDir, { recursive: true });
await mkdir(logDir, { recursive: true });
await loadMetadata();
await cleanupExpiredFiles();
setInterval(cleanupExpiredFiles, 10 * 60 * 1000).unref();

const server = createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (requestUrl.pathname.startsWith("/api/")) {
      await handleApi(req, res, requestUrl);
      return;
    }

    await serveStatic(req, res, requestUrl);
  } catch (error) {
    console.error(error);
    sendJson(res, 500, { error: "服务器出错了，请稍后再试。" });
  }
});

server.listen(config.port, config.host, () => {
  console.log(`Temporary transfer site: http://${config.host}:${config.port}`);
  console.log(`Data directory: ${config.dataDir}`);
  console.log(`Files expire after ${config.ttlHours} hour(s).`);
  console.log(config.transferPin ? "TRANSFER_PIN protection is enabled." : "TRANSFER_PIN protection is disabled for local development.");
});

async function handleApi(req, res, url) {
  if (!isAuthorized(req)) {
    sendJson(res, 401, { error: "需要访问 PIN。" });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/config") {
    sendJson(res, 200, {
      ttlHours: config.ttlHours,
      maxFileMb: config.maxFileMb,
      pinRequired: Boolean(config.transferPin)
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/files") {
    await cleanupExpiredFiles();
    sendJson(res, 200, { files: getVisibleFiles() });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/upload") {
    await handleUpload(req, res);
    return;
  }

  const downloadMatch = url.pathname.match(/^\/api\/files\/([^/]+)\/download$/);
  if (req.method === "GET" && downloadMatch) {
    await handleDownload(res, downloadMatch[1]);
    return;
  }

  const deleteMatch = url.pathname.match(/^\/api\/files\/([^/]+)$/);
  if (req.method === "DELETE" && deleteMatch) {
    await deleteFile(deleteMatch[1]);
    sendJson(res, 200, { ok: true });
    return;
  }

  sendJson(res, 404, { error: "接口不存在。" });
}

async function handleUpload(req, res) {
  const originalName = decodeURIComponent(String(req.headers["x-file-name"] || "unnamed-file")).trim();
  if (!originalName) {
    sendJson(res, 400, { error: "缺少文件名。" });
    return;
  }

  const expectedSize = Number(req.headers["content-length"] || 0);
  if (expectedSize > config.maxFileBytes) {
    sendJson(res, 413, { error: `文件太大，最大支持 ${formatBytes(config.maxFileBytes)}。` });
    return;
  }

  const id = crypto.randomUUID();
  const safeName = sanitizeFileName(originalName);
  const storedName = `${id}${path.extname(safeName)}`;
  const finalPath = path.join(uploadDir, storedName);
  const tempPath = `${finalPath}.part`;
  const now = Date.now();

  let received = 0;
  const output = createWriteStream(tempPath, { flags: "wx" });

  req.on("data", (chunk) => {
    received += chunk.length;
    if (received > config.maxFileBytes) {
      req.destroy(new Error("FILE_TOO_LARGE"));
    }
  });

  try {
    await new Promise((resolve, reject) => {
      req.pipe(output);
      req.on("error", reject);
      output.on("error", reject);
      output.on("finish", resolve);
    });
  } catch (error) {
    await rm(tempPath, { force: true });
    if (error.message === "FILE_TOO_LARGE") {
      sendJson(res, 413, { error: `文件太大，最大支持 ${formatBytes(config.maxFileBytes)}。` });
      return;
    }
    throw error;
  }

  await rename(tempPath, finalPath);

  const record = {
    id,
    originalName: safeName,
    storedName,
    size: received,
    uploadedAt: now,
    expiresAt: now + config.ttlHours * 60 * 60 * 1000
  };
  files.set(id, record);
  await saveMetadata();

  sendJson(res, 201, { file: toClientFile(record) });
}

async function handleDownload(res, id) {
  const record = files.get(id);
  if (!record || isExpired(record)) {
    if (record) {
      await deleteFile(record.id);
    }
    sendJson(res, 404, { error: "文件不存在或已过期。" });
    return;
  }

  const filePath = path.join(uploadDir, record.storedName);
  let fileStat;
  try {
    fileStat = await stat(filePath);
  } catch {
    files.delete(id);
    await saveMetadata();
    sendJson(res, 404, { error: "文件不存在。" });
    return;
  }

  res.writeHead(200, {
    "Content-Type": "application/octet-stream",
    "Content-Length": fileStat.size,
    "Content-Disposition": `attachment; filename="${encodeHeaderFileName(record.originalName)}"; filename*=UTF-8''${encodeURIComponent(record.originalName)}`,
    "Cache-Control": "no-store"
  });

  createReadStream(filePath).pipe(res);
}

async function serveStatic(req, res, url) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405);
    res.end();
    return;
  }

  const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
  const decodedPath = decodeURIComponent(pathname);
  const requestedPath = path.normalize(path.join(publicDir, decodedPath));

  if (!requestedPath.startsWith(publicDir)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const file = await readFile(requestedPath);
    res.writeHead(200, {
      "Content-Type": mimeTypes.get(path.extname(requestedPath).toLowerCase()) || "application/octet-stream",
      "Cache-Control": "no-store"
    });
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    res.end(file);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

async function loadMetadata() {
  try {
    const raw = await readFile(metadataPath, "utf8");
    const parsed = JSON.parse(raw);
    files = new Map((parsed.files || []).map((file) => [file.id, file]));
  } catch {
    files = new Map();
    await saveMetadata();
  }
}

async function saveMetadata() {
  const payload = JSON.stringify({ files: [...files.values()] }, null, 2);
  await writeFile(metadataPath, `${payload}\n`, "utf8");
}

async function cleanupExpiredFiles() {
  let changed = false;
  for (const record of files.values()) {
    if (isExpired(record)) {
      await rm(path.join(uploadDir, record.storedName), { force: true });
      files.delete(record.id);
      changed = true;
    }
  }

  try {
    const entries = await readdir(uploadDir);
    await Promise.all(entries.filter((entry) => entry.endsWith(".part")).map((entry) => rm(path.join(uploadDir, entry), { force: true })));
  } catch {
    // Upload directory is created on startup; this only guards unusual runtime races.
  }

  if (changed) {
    await saveMetadata();
  }
}

async function deleteFile(id) {
  const record = files.get(id);
  if (!record) {
    return;
  }
  files.delete(id);
  await rm(path.join(uploadDir, record.storedName), { force: true });
  await saveMetadata();
}

function readConfig() {
  const host = process.env.HOST || "127.0.0.1";
  const port = readPositiveInteger("PORT", 3000);
  const ttlHours = readPositiveNumber("TTL_HOURS", 24);
  const maxFileMb = readPositiveNumber("MAX_FILE_MB", 2048);
  const transferPin = process.env.TRANSFER_PIN || "";
  const allowEmptyPin = readBoolean("ALLOW_EMPTY_PIN", false);
  const dataDir = path.resolve(__dirname, process.env.DATA_DIR || "./data");
  const productionMode = process.env.NODE_ENV === "production";
  const publicBind = !["127.0.0.1", "localhost", "::1"].includes(host);

  if (!transferPin && !allowEmptyPin && (productionMode || publicBind)) {
    console.error("TRANSFER_PIN is required when NODE_ENV=production or HOST is not local. Set TRANSFER_PIN or ALLOW_EMPTY_PIN=true for explicit local testing.");
    process.exit(1);
  }

  return {
    host,
    port,
    ttlHours,
    maxFileMb,
    maxFileBytes: maxFileMb * 1024 * 1024,
    transferPin,
    dataDir
  };
}

function loadDotEnv(filePath) {
  let raw;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return;
  }

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separator = trimmed.indexOf("=");
    if (separator === -1) {
      continue;
    }

    const key = trimmed.slice(0, separator).trim();
    const value = unquoteEnvValue(trimmed.slice(separator + 1).trim());
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function unquoteEnvValue(value) {
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function readPositiveInteger(name, fallback) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function readPositiveNumber(name, fallback) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number.`);
  }
  return value;
}

function readBoolean(name, fallback) {
  const value = process.env[name];
  if (value === undefined) {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function getVisibleFiles() {
  return [...files.values()]
    .filter((record) => !isExpired(record))
    .sort((a, b) => b.uploadedAt - a.uploadedAt)
    .map(toClientFile);
}

function toClientFile(record) {
  return {
    id: record.id,
    name: record.originalName,
    size: record.size,
    uploadedAt: record.uploadedAt,
    expiresAt: record.expiresAt
  };
}

function isExpired(record) {
  return Date.now() >= record.expiresAt;
}

function isAuthorized(req) {
  if (!config.transferPin) {
    return true;
  }
  return req.headers["x-transfer-pin"] === config.transferPin;
}

function sanitizeFileName(name) {
  const baseName = path.basename(name).replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_");
  return baseName || "unnamed-file";
}

function encodeHeaderFileName(name) {
  return name.replace(/["\\]/g, "_").replace(/[^\x20-\x7e]/g, "_");
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(body));
}

function formatBytes(bytes) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

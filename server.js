import { createServer } from "node:http";
import { createReadStream, createWriteStream, existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

loadDotEnv(path.join(__dirname, ".env"));

const config = readConfig();
const publicDir = path.join(__dirname, "public");
const uploadDir = path.join(config.dataDir, "uploads");
const logDir = path.join(config.dataDir, "logs");
const metadataPath = path.join(config.dataDir, "files.json");
const sqlitePath = path.join(config.dataDir, "files.db");

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

const pinFailureLimiter = createRateLimiter({
  windowMs: 10 * 60 * 1000,
  max: config.pinFailureLimit
});
const uploadLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: config.uploadsPerMinute
});

let store;

async function main() {
  await mkdir(uploadDir, { recursive: true });
  await mkdir(logDir, { recursive: true });

  store = await createFileStore();
  await cleanupExpiredFiles();
  await reconcileUploadDirectory();
  setInterval(cleanupExpiredFiles, 10 * 60 * 1000).unref();
  setInterval(cleanupTemporaryUploads, 30 * 60 * 1000).unref();

  const server = createServer(async (req, res) => {
    applySecurityHeaders(res);

    try {
      const requestUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

      const publicDownloadMatch = requestUrl.pathname.match(/^\/d\/([^/]+)$/);
      if ((req.method === "GET" || req.method === "HEAD") && publicDownloadMatch) {
        await handleDownload(req, res, publicDownloadMatch[1], requestUrl, { requireToken: true });
        return;
      }

      if (requestUrl.pathname.startsWith("/api/")) {
        await handleApi(req, res, requestUrl);
        return;
      }

      await serveStatic(req, res, requestUrl);
    } catch (error) {
      console.error(error);
      if (!res.headersSent) {
        sendJson(res, 500, { error: "internal server error" });
      } else {
        res.destroy(error);
      }
    }
  });

  server.listen(config.port, config.host, () => {
    console.log(`Temporary transfer site: http://${config.host}:${config.port}`);
    console.log(`Data directory: ${config.dataDir}`);
    console.log(`Metadata store: ${store.name}`);
    console.log(`Files expire after ${config.ttlHours} hour(s).`);
    console.log(`Max file size: ${formatBytes(config.maxFileBytes)}.`);
    console.log(`Total storage quota: ${formatBytes(config.totalQuotaBytes)}.`);
    console.log(config.transferPin ? "TRANSFER_PIN protection is enabled." : "TRANSFER_PIN protection is disabled for local development.");
  });
}

async function handleApi(req, res, url) {
  const clientKey = getClientKey(req);
  if (!isAuthorized(req)) {
    const limit = pinFailureLimiter.consume(clientKey);
    if (!limit.allowed) {
      sendJson(res, 429, { error: "too many attempts, try later" });
      return;
    }
    sendJson(res, 401, { error: "invalid or missing PIN" });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/config") {
    sendJson(res, 200, {
      ttlHours: config.ttlHours,
      maxFileMb: config.maxFileMb,
      totalQuotaGb: config.totalQuotaGb,
      resumableChunkMb: config.resumableChunkMb,
      pinRequired: Boolean(config.transferPin)
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/files") {
    await cleanupExpiredFiles();
    sendJson(res, 200, { files: await getVisibleFiles() });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/upload") {
    const limit = uploadLimiter.consume(clientKey);
    if (!limit.allowed) {
      sendJson(res, 429, { error: "too many uploads, try later" });
      return;
    }
    await handleUpload(req, res);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/uploads/resumable/init") {
    const limit = uploadLimiter.consume(clientKey);
    if (!limit.allowed) {
      sendJson(res, 429, { error: "too many uploads, try later" });
      return;
    }
    await handleResumableInit(req, res);
    return;
  }

  const resumableMatch = url.pathname.match(/^\/api\/uploads\/resumable\/([^/]+)$/);
  if (resumableMatch) {
    if (req.method === "GET") {
      await handleResumableStatus(res, resumableMatch[1]);
      return;
    }
    if (req.method === "PATCH") {
      await handleResumableChunk(req, res, resumableMatch[1]);
      return;
    }
    if (req.method === "DELETE") {
      await deleteResumableSession(resumableMatch[1]);
      sendJson(res, 200, { ok: true });
      return;
    }
  }

  const downloadMatch = url.pathname.match(/^\/api\/files\/([^/]+)\/download$/);
  if ((req.method === "GET" || req.method === "HEAD") && downloadMatch) {
    await handleDownload(req, res, downloadMatch[1], url, { requireToken: false });
    return;
  }

  const deleteMatch = url.pathname.match(/^\/api\/files\/([^/]+)$/);
  if (req.method === "DELETE" && deleteMatch) {
    await deleteFile(deleteMatch[1]);
    sendJson(res, 200, { ok: true });
    return;
  }

  sendJson(res, 404, { error: "not found" });
}

async function handleUpload(req, res) {
  const originalName = decodeURIComponent(String(req.headers["x-file-name"] || "unnamed-file")).trim();
  if (!originalName) {
    sendJson(res, 400, { error: "missing file name" });
    return;
  }

  const declaredSize = readContentLength(req);
  if (declaredSize === null) {
    sendJson(res, 411, { error: "content-length is required" });
    return;
  }

  if (declaredSize <= 0) {
    sendJson(res, 400, { error: "empty uploads are not accepted" });
    return;
  }

  if (declaredSize > config.maxFileBytes) {
    sendJson(res, 413, { error: `file is larger than ${formatBytes(config.maxFileBytes)}` });
    return;
  }

  await cleanupExpiredFiles();
  const usedBytes = await store.sumSize();
  if (usedBytes + declaredSize > config.totalQuotaBytes) {
    sendJson(res, 507, { error: "storage quota exceeded" });
    return;
  }

  const id = crypto.randomUUID();
  const token = crypto.randomBytes(24).toString("base64url");
  const safeName = sanitizeFileName(originalName);
  const storedName = `${id}${path.extname(safeName)}`;
  const finalPath = path.join(uploadDir, storedName);
  const tempPath = path.join(uploadDir, `.tmp-${id}${path.extname(safeName)}`);
  const now = Date.now();

  let received = 0;
  const output = createWriteStream(tempPath, { flags: "wx" });

  req.on("data", (chunk) => {
    received += chunk.length;
    if (received > config.maxFileBytes || usedBytes + received > config.totalQuotaBytes) {
      req.destroy(new Error(received > config.maxFileBytes ? "FILE_TOO_LARGE" : "QUOTA_EXCEEDED"));
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
      sendJson(res, 413, { error: `file is larger than ${formatBytes(config.maxFileBytes)}` });
      return;
    }
    if (error.message === "QUOTA_EXCEEDED") {
      sendJson(res, 507, { error: "storage quota exceeded" });
      return;
    }
    throw error;
  }

  if (received !== declaredSize) {
    await rm(tempPath, { force: true });
    sendJson(res, 400, { error: "upload was interrupted" });
    return;
  }

  await rename(tempPath, finalPath);

  const record = {
    id,
    originalName: safeName,
    storedName,
    size: received,
    uploadedAt: now,
    expiresAt: now + config.ttlHours * 60 * 60 * 1000,
    token
  };
  await store.upsert(record);

  sendJson(res, 201, { file: toClientFile(record) });
}

async function handleResumableInit(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    if (error.message === "JSON_BODY_TOO_LARGE") {
      sendJson(res, 413, { error: "request body is too large" });
      return;
    }
    throw error;
  }
  const originalName = String(body.name || "").trim();
  const size = Number(body.size);

  if (!originalName) {
    sendJson(res, 400, { error: "missing file name" });
    return;
  }
  if (!Number.isSafeInteger(size) || size <= 0) {
    sendJson(res, 400, { error: "invalid file size" });
    return;
  }
  if (size > config.maxFileBytes) {
    sendJson(res, 413, { error: `file is larger than ${formatBytes(config.maxFileBytes)}` });
    return;
  }

  await cleanupExpiredFiles();
  const usedBytes = await store.sumSize();
  const pendingBytes = await getPendingUploadBytes();
  if (usedBytes + pendingBytes + size > config.totalQuotaBytes) {
    sendJson(res, 507, { error: "storage quota exceeded" });
    return;
  }

  const id = crypto.randomUUID();
  const token = crypto.randomBytes(24).toString("base64url");
  const safeName = sanitizeFileName(originalName);
  const storedName = `${id}${path.extname(safeName)}`;
  const now = Date.now();
  const session = {
    id,
    originalName: safeName,
    storedName,
    size,
    uploadedAt: now,
    expiresAt: now + config.ttlHours * 60 * 60 * 1000,
    token,
    chunkSize: config.resumableChunkBytes
  };

  await writeFile(getResumableTempPath(id), "", { flag: "wx" });
  await saveResumableSession(session);

  sendJson(res, 201, {
    uploadId: id,
    receivedBytes: 0,
    chunkSize: config.resumableChunkBytes,
    expiresAt: session.expiresAt
  });
}

async function handleResumableStatus(res, id) {
  const session = await loadResumableSession(id);
  if (!session) {
    sendJson(res, 404, { error: "upload session not found" });
    return;
  }

  const receivedBytes = await getFileSize(getResumableTempPath(id));
  sendJson(res, 200, {
    uploadId: id,
    receivedBytes,
    size: session.size,
    chunkSize: session.chunkSize || config.resumableChunkBytes,
    expiresAt: session.expiresAt
  });
}

async function handleResumableChunk(req, res, id) {
  const session = await loadResumableSession(id);
  if (!session) {
    sendJson(res, 404, { error: "upload session not found" });
    return;
  }

  if (Date.now() >= session.expiresAt) {
    await deleteResumableSession(id);
    sendJson(res, 404, { error: "upload session expired" });
    return;
  }

  const declaredSize = readContentLength(req);
  const offset = Number(req.headers["x-upload-offset"]);
  if (declaredSize === null || !Number.isSafeInteger(offset) || offset < 0) {
    sendJson(res, 400, { error: "content-length and x-upload-offset are required" });
    return;
  }
  if (declaredSize <= 0 || declaredSize > (session.chunkSize || config.resumableChunkBytes)) {
    sendJson(res, 413, { error: `chunk must be between 1 byte and ${formatBytes(session.chunkSize || config.resumableChunkBytes)}` });
    return;
  }
  if (offset + declaredSize > session.size) {
    sendJson(res, 413, { error: "chunk exceeds declared file size" });
    return;
  }

  const tempPath = getResumableTempPath(id);
  const receivedBytes = await getFileSize(tempPath);
  if (receivedBytes !== offset) {
    sendJson(res, 409, { error: "upload offset mismatch", receivedBytes });
    return;
  }

  const output = createWriteStream(tempPath, { flags: "a" });
  let received = 0;
  req.on("data", (chunk) => {
    received += chunk.length;
    if (received > declaredSize) {
      req.destroy(new Error("CHUNK_TOO_LARGE"));
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
    if (error.message === "CHUNK_TOO_LARGE") {
      sendJson(res, 413, { error: "chunk is larger than declared content-length" });
      return;
    }
    throw error;
  }

  if (received !== declaredSize) {
    sendJson(res, 400, { error: "chunk upload was interrupted" });
    return;
  }

  const nextOffset = offset + received;
  if (nextOffset < session.size) {
    sendJson(res, 200, { uploadId: id, receivedBytes: nextOffset, complete: false });
    return;
  }

  const finalPath = path.join(uploadDir, session.storedName);
  await rename(tempPath, finalPath);
  await rm(getResumableSessionPath(id), { force: true });

  const record = {
    id: session.id,
    originalName: session.originalName,
    storedName: session.storedName,
    size: session.size,
    uploadedAt: session.uploadedAt,
    expiresAt: session.expiresAt,
    token: session.token
  };
  await store.upsert(record);

  sendJson(res, 201, { uploadId: id, receivedBytes: nextOffset, complete: true, file: toClientFile(record) });
}

async function handleDownload(req, res, id, url, options) {
  const record = await store.get(id);
  if (!record || isExpired(record)) {
    if (record) {
      await deleteFile(record.id);
    }
    sendJson(res, 404, { error: "file not found or expired" });
    return;
  }

  if (options.requireToken && !safeComparePin(url.searchParams.get("t") || "", record.token || "")) {
    sendJson(res, 403, { error: "invalid download token" });
    return;
  }

  const oneTime = url.searchParams.get("once") === "1";
  if (oneTime && req.headers.range) {
    sendJson(res, 400, { error: "one-time downloads do not support range requests" });
    return;
  }

  const filePath = path.join(uploadDir, record.storedName);
  let fileStat;
  try {
    fileStat = await stat(filePath);
  } catch {
    await store.delete(id);
    sendJson(res, 404, { error: "file not found" });
    return;
  }

  const range = parseRange(req.headers.range, fileStat.size);
  if (range?.unsatisfiable) {
    res.writeHead(416, {
      "Content-Range": `bytes */${fileStat.size}`,
      "Cache-Control": "no-store"
    });
    res.end();
    return;
  }

  const start = range ? range.start : 0;
  const end = range ? range.end : fileStat.size - 1;
  const contentLength = end - start + 1;
  const status = range ? 206 : 200;

  res.writeHead(status, {
    "Content-Type": "application/octet-stream",
    "X-Content-Type-Options": "nosniff",
    "Content-Length": contentLength,
    "Accept-Ranges": "bytes",
    "Content-Disposition": `attachment; filename="${encodeHeaderFileName(record.originalName)}"; filename*=UTF-8''${encodeURIComponent(record.originalName)}`,
    "Cache-Control": "no-store",
    ...(range ? { "Content-Range": `bytes ${start}-${end}/${fileStat.size}` } : {})
  });

  if (req.method === "HEAD") {
    res.end();
    return;
  }

  const stream = createReadStream(filePath, { start, end });
  stream.on("error", (error) => res.destroy(error));
  stream.pipe(res);

  if (oneTime && !range) {
    res.on("finish", async () => {
      if (res.statusCode === 200) {
        await deleteFile(id).catch((error) => console.error("one-time delete failed", error));
      }
    });
  }
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

async function createFileStore() {
  let Database;
  try {
    Database = require("better-sqlite3");
  } catch {
    console.warn("better-sqlite3 is not installed; falling back to files.json metadata.");
    const store = new JsonFileStore(metadataPath);
    await store.init();
    return store;
  }

  const store = new SqliteFileStore(Database, sqlitePath, metadataPath);
  await store.init();
  return store;
}

class JsonFileStore {
  constructor(filePath) {
    this.name = "JSON fallback";
    this.filePath = filePath;
    this.files = new Map();
  }

  async init() {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      this.files = new Map((parsed.files || []).map((file) => [file.id, normalizeRecord(file)]));
    } catch {
      this.files = new Map();
      await this.save();
    }
  }

  async get(id) {
    return this.files.get(id) || null;
  }

  async list() {
    return [...this.files.values()];
  }

  async listExpired(now) {
    return [...this.files.values()].filter((record) => record.expiresAt <= now);
  }

  async upsert(record) {
    this.files.set(record.id, normalizeRecord(record));
    await this.save();
  }

  async delete(id) {
    this.files.delete(id);
    await this.save();
  }

  async deleteExpired(now) {
    let changed = false;
    for (const record of this.files.values()) {
      if (record.expiresAt <= now) {
        this.files.delete(record.id);
        changed = true;
      }
    }
    if (changed) {
      await this.save();
    }
  }

  async sumSize() {
    return [...this.files.values()].reduce((total, record) => total + record.size, 0);
  }

  async save() {
    const payload = `${JSON.stringify({ files: [...this.files.values()] }, null, 2)}\n`;
    const tempPath = `${this.filePath}.tmp`;
    await writeFile(tempPath, payload, "utf8");
    await rename(tempPath, this.filePath);
  }
}

class SqliteFileStore {
  constructor(Database, dbPath, jsonPath) {
    this.name = "SQLite";
    this.db = new Database(dbPath);
    this.jsonPath = jsonPath;
  }

  async init() {
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS files (
        id TEXT PRIMARY KEY,
        original_name TEXT NOT NULL,
        stored_name TEXT NOT NULL UNIQUE,
        size INTEGER NOT NULL,
        uploaded_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        token TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_files_expires_at ON files(expires_at);
      CREATE INDEX IF NOT EXISTS idx_files_stored_name ON files(stored_name);
    `);
    await this.importJsonMetadata();
  }

  async importJsonMetadata() {
    if (!existsSync(this.jsonPath)) {
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(await readFile(this.jsonPath, "utf8"));
    } catch {
      return;
    }

    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO files (id, original_name, stored_name, size, uploaded_at, expires_at, token)
      VALUES (@id, @originalName, @storedName, @size, @uploadedAt, @expiresAt, @token)
    `);
    const importRecords = this.db.transaction((records) => {
      for (const record of records) {
        insert.run(normalizeRecord(record));
      }
    });
    importRecords(parsed.files || []);
  }

  async get(id) {
    return rowToRecord(this.db.prepare("SELECT * FROM files WHERE id = ?").get(id));
  }

  async list() {
    return this.db.prepare("SELECT * FROM files").all().map(rowToRecord);
  }

  async listExpired(now) {
    return this.db.prepare("SELECT * FROM files WHERE expires_at <= ?").all(now).map(rowToRecord);
  }

  async upsert(record) {
    this.db.prepare(`
      INSERT INTO files (id, original_name, stored_name, size, uploaded_at, expires_at, token)
      VALUES (@id, @originalName, @storedName, @size, @uploadedAt, @expiresAt, @token)
      ON CONFLICT(id) DO UPDATE SET
        original_name = excluded.original_name,
        stored_name = excluded.stored_name,
        size = excluded.size,
        uploaded_at = excluded.uploaded_at,
        expires_at = excluded.expires_at,
        token = excluded.token
    `).run(normalizeRecord(record));
  }

  async delete(id) {
    this.db.prepare("DELETE FROM files WHERE id = ?").run(id);
  }

  async deleteExpired(now) {
    this.db.prepare("DELETE FROM files WHERE expires_at <= ?").run(now);
  }

  async sumSize() {
    return this.db.prepare("SELECT COALESCE(SUM(size), 0) AS s FROM files").get().s;
  }
}

function rowToRecord(row) {
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    originalName: row.original_name,
    storedName: row.stored_name,
    size: row.size,
    uploadedAt: row.uploaded_at,
    expiresAt: row.expires_at,
    token: row.token
  };
}

function normalizeRecord(record) {
  return {
    id: String(record.id),
    originalName: sanitizeFileName(record.originalName || record.original_name || "unnamed-file"),
    storedName: String(record.storedName || record.stored_name || `${record.id}`),
    size: Number(record.size || 0),
    uploadedAt: Number(record.uploadedAt || record.uploaded_at || Date.now()),
    expiresAt: Number(record.expiresAt || record.expires_at || Date.now()),
    token: String(record.token || crypto.randomBytes(24).toString("base64url"))
  };
}

async function cleanupExpiredFiles() {
  const now = Date.now();
  const expiredRecords = await store.listExpired(now);
  for (const record of expiredRecords) {
    await rm(path.join(uploadDir, record.storedName), { force: true });
  }
  await store.deleteExpired(now);

  await cleanupTemporaryUploads();
}

async function cleanupTemporaryUploads() {
  let entries;
  try {
    entries = await readdir(uploadDir, { withFileTypes: true });
  } catch {
    return;
  }

  const now = Date.now();
  await Promise.all(entries.map(async (entry) => {
    if (!entry.isFile() || (!entry.name.startsWith(".tmp-") && !entry.name.endsWith(".part"))) {
      return;
    }

    const fullPath = path.join(uploadDir, entry.name);
    try {
      if (entry.name.startsWith(".tmp-upload-")) {
        const id = entry.name.replace(/^\.tmp-upload-/, "").replace(/\.(json|part)$/, "");
        const session = await loadResumableSession(id);
        if (!session || now >= session.expiresAt) {
          await deleteResumableSession(id);
        }
        return;
      }

      const fileStat = await stat(fullPath);
      if (now - fileStat.mtimeMs >= 60 * 60 * 1000) {
        await rm(fullPath, { force: true });
      }
    } catch {
      // Another cleanup or upload may have moved it already.
    }
  }));
}

async function getPendingUploadBytes() {
  const sessions = await listResumableSessions();
  return sessions.reduce((total, session) => total + session.size, 0);
}

async function listResumableSessions() {
  let entries;
  try {
    entries = await readdir(uploadDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const sessions = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith(".tmp-upload-") || !entry.name.endsWith(".json")) {
      continue;
    }
    const id = entry.name.slice(".tmp-upload-".length, -".json".length);
    const session = await loadResumableSession(id);
    if (session) {
      sessions.push(session);
    }
  }
  return sessions;
}

async function loadResumableSession(id) {
  if (!isSafeId(id)) {
    return null;
  }

  try {
    const raw = await readFile(getResumableSessionPath(id), "utf8");
    return normalizeResumableSession(JSON.parse(raw));
  } catch {
    return null;
  }
}

async function saveResumableSession(session) {
  const normalized = normalizeResumableSession(session);
  const sessionPath = getResumableSessionPath(normalized.id);
  const tempPath = `${sessionPath}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  await rename(tempPath, sessionPath);
}

async function deleteResumableSession(id) {
  if (!isSafeId(id)) {
    return;
  }
  await rm(getResumableTempPath(id), { force: true });
  await rm(getResumableSessionPath(id), { force: true });
}

function normalizeResumableSession(session) {
  return {
    id: String(session.id),
    originalName: sanitizeFileName(session.originalName || "unnamed-file"),
    storedName: String(session.storedName || session.id),
    size: Number(session.size || 0),
    uploadedAt: Number(session.uploadedAt || Date.now()),
    expiresAt: Number(session.expiresAt || Date.now()),
    token: String(session.token || crypto.randomBytes(24).toString("base64url")),
    chunkSize: Number(session.chunkSize || config.resumableChunkBytes)
  };
}

function getResumableTempPath(id) {
  return path.join(uploadDir, `.tmp-upload-${id}.part`);
}

function getResumableSessionPath(id) {
  return path.join(uploadDir, `.tmp-upload-${id}.json`);
}

async function getFileSize(filePath) {
  try {
    return (await stat(filePath)).size;
  } catch {
    return 0;
  }
}

async function reconcileUploadDirectory() {
  const records = await store.list();
  const recordsByStoredName = new Map(records.map((record) => [record.storedName, record]));
  const entries = await readdir(uploadDir, { withFileTypes: true });
  const fileNames = new Set(entries.filter((entry) => entry.isFile()).map((entry) => entry.name));

  for (const record of records) {
    if (!fileNames.has(record.storedName)) {
      await store.delete(record.id);
    }
  }

  await Promise.all([...fileNames]
    .filter((name) => !name.startsWith(".tmp-") && !name.endsWith(".part") && !recordsByStoredName.has(name))
    .map((name) => rm(path.join(uploadDir, name), { force: true })));
}

async function deleteFile(id) {
  const record = await store.get(id);
  if (!record) {
    return;
  }
  await store.delete(id);
  await rm(path.join(uploadDir, record.storedName), { force: true });
}

function readConfig() {
  const host = process.env.HOST || "127.0.0.1";
  const port = readPositiveInteger("PORT", 3000);
  const ttlHours = readPositiveNumber("TTL_HOURS", 24);
  const maxFileMb = readPositiveNumber("MAX_FILE_MB", 2048);
  const totalQuotaGb = readPositiveNumber("TOTAL_QUOTA_GB", 20);
  const resumableChunkMb = readPositiveNumber("RESUMABLE_CHUNK_MB", 8);
  const transferPin = process.env.TRANSFER_PIN || "";
  const allowEmptyPin = readBoolean("ALLOW_EMPTY_PIN", false);
  const dataDir = path.resolve(__dirname, process.env.DATA_DIR || "./data");
  const productionMode = process.env.NODE_ENV === "production";
  const publicBind = !["127.0.0.1", "localhost", "::1"].includes(host);
  const pinFailureLimit = readPositiveInteger("PIN_FAILURE_LIMIT", 20);
  const uploadsPerMinute = readPositiveInteger("UPLOADS_PER_MINUTE", 10);

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
    totalQuotaGb,
    totalQuotaBytes: totalQuotaGb * 1024 ** 3,
    resumableChunkMb,
    resumableChunkBytes: Math.max(1, Math.floor(resumableChunkMb * 1024 * 1024)),
    transferPin,
    pinFailureLimit,
    uploadsPerMinute,
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

async function getVisibleFiles() {
  return (await store.list())
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
    expiresAt: record.expiresAt,
    downloadUrl: `/d/${encodeURIComponent(record.id)}?t=${encodeURIComponent(record.token)}`
  };
}

function isExpired(record) {
  return Date.now() >= record.expiresAt;
}

function isAuthorized(req) {
  if (!config.transferPin) {
    return true;
  }
  return safeComparePin(String(req.headers["x-transfer-pin"] || ""), config.transferPin);
}

function safeComparePin(input, expected) {
  if (typeof input !== "string" || typeof expected !== "string") {
    return false;
  }

  const inputBuffer = Buffer.from(input);
  const expectedBuffer = Buffer.from(expected);
  if (inputBuffer.length !== expectedBuffer.length) {
    crypto.timingSafeEqual(expectedBuffer, expectedBuffer);
    return false;
  }
  return crypto.timingSafeEqual(inputBuffer, expectedBuffer);
}

function createRateLimiter({ windowMs, max }) {
  const buckets = new Map();

  return {
    consume(key) {
      const now = Date.now();
      const bucket = buckets.get(key);
      if (!bucket || now >= bucket.resetAt) {
        buckets.set(key, { count: 1, resetAt: now + windowMs });
        pruneRateLimitBuckets(buckets, now);
        return { allowed: true, remaining: max - 1 };
      }

      bucket.count += 1;
      return { allowed: bucket.count <= max, remaining: Math.max(0, max - bucket.count) };
    }
  };
}

function pruneRateLimitBuckets(buckets, now) {
  if (buckets.size < 1000) {
    return;
  }
  for (const [key, bucket] of buckets) {
    if (now >= bucket.resetAt) {
      buckets.delete(key);
    }
  }
}

function getClientKey(req) {
  const forwardedFor = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return forwardedFor || req.socket.remoteAddress || "unknown";
}

function readContentLength(req) {
  const raw = req.headers["content-length"];
  if (raw === undefined) {
    return null;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    return null;
  }
  return value;
}

async function readJsonBody(req, maxBytes = 64 * 1024) {
  const declaredSize = readContentLength(req);
  if (declaredSize !== null && declaredSize > maxBytes) {
    throw new Error("JSON_BODY_TOO_LARGE");
  }

  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      throw new Error("JSON_BODY_TOO_LARGE");
    }
    chunks.push(chunk);
  }

  if (!chunks.length) {
    return {};
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return {};
  }
}

function parseRange(header, size) {
  if (!header) {
    return null;
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!match) {
    return { unsatisfiable: true };
  }

  let start;
  let end;
  if (match[1] === "" && match[2] === "") {
    return { unsatisfiable: true };
  }

  if (match[1] === "") {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
      return { unsatisfiable: true };
    }
    start = Math.max(size - suffixLength, 0);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === "" ? size - 1 : Number(match[2]);
  }

  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) {
    return { unsatisfiable: true };
  }

  return { start, end: Math.min(end, size - 1) };
}

function sanitizeFileName(name) {
  const baseName = path.basename(name).replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_");
  return baseName || "unnamed-file";
}

function encodeHeaderFileName(name) {
  return name.replace(/["\\]/g, "_").replace(/[^\x20-\x7e]/g, "_");
}

function isSafeId(id) {
  return /^[a-f0-9-]{36}$/.test(String(id));
}

function applySecurityHeaders(res) {
  res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
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

await main();

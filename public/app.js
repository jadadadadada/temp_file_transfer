const state = {
  files: [],
  config: null,
  pin: localStorage.getItem("transferPin") || ""
};

const els = {
  configText: document.querySelector("#configText"),
  uploadHint: document.querySelector("#uploadHint"),
  dropzone: document.querySelector("#dropzone"),
  fileInput: document.querySelector("#fileInput"),
  progressArea: document.querySelector("#progressArea"),
  fileList: document.querySelector("#fileList"),
  fileCount: document.querySelector("#fileCount"),
  emptyState: document.querySelector("#emptyState"),
  fileTemplate: document.querySelector("#fileTemplate"),
  refreshButton: document.querySelector("#refreshButton"),
  pinPanel: document.querySelector("#pinPanel"),
  pinInput: document.querySelector("#pinInput"),
  pinButton: document.querySelector("#pinButton")
};

init();

async function init() {
  bindEvents();
  els.pinInput.value = state.pin;
  await loadConfig();
  await loadFiles();
  setInterval(loadFiles, 30 * 1000);
  setInterval(renderFiles, 1000);
}

function bindEvents() {
  els.refreshButton.addEventListener("click", loadFiles);

  els.fileInput.addEventListener("change", async () => {
    await uploadFiles([...els.fileInput.files]);
    els.fileInput.value = "";
  });

  els.dropzone.addEventListener("dragover", (event) => {
    event.preventDefault();
    els.dropzone.classList.add("dragover");
  });

  els.dropzone.addEventListener("dragleave", () => {
    els.dropzone.classList.remove("dragover");
  });

  els.dropzone.addEventListener("drop", async (event) => {
    event.preventDefault();
    els.dropzone.classList.remove("dragover");
    await uploadFiles([...event.dataTransfer.files]);
  });

  document.addEventListener("paste", async (event) => {
    const files = [...event.clipboardData.files];
    if (files.length) {
      await uploadFiles(files);
    }
  });

  els.pinButton.addEventListener("click", () => {
    state.pin = els.pinInput.value.trim();
    localStorage.setItem("transferPin", state.pin);
    loadConfig();
    loadFiles();
  });

  els.pinInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      els.pinButton.click();
    }
  });
}

async function loadConfig() {
  try {
    const config = await requestJson("/api/config");
    state.config = config;
    els.configText.textContent = `Files expire after ${config.ttlHours}h. Max file ${config.maxFileMb} MB. Total quota ${config.totalQuotaGb} GB.`;
    els.uploadHint.textContent = `Drop, choose, or paste a file. Uploads are PIN-protected and expire automatically.`;
    els.pinPanel.classList.toggle("hidden", !config.pinRequired);
  } catch (error) {
    showMessage(error.message || "Failed to load config.", true);
    if (error.status === 401) {
      els.pinPanel.classList.remove("hidden");
      els.configText.textContent = "Enter the transfer PIN to continue.";
    }
  }
}

async function loadFiles() {
  try {
    const data = await requestJson("/api/files");
    state.files = data.files;
    renderFiles();
  } catch (error) {
    if (error.status === 401) {
      els.pinPanel.classList.remove("hidden");
      els.configText.textContent = "Enter the transfer PIN to continue.";
      return;
    }
    showMessage(error.message || "Failed to load files.", true);
  }
}

async function uploadFiles(files) {
  if (!files.length) {
    return;
  }

  for (const file of files) {
    await uploadOne(file);
  }
  await loadFiles();
}

async function uploadOne(file) {
  const chunkSize = getResumableChunkSize();
  if (file.size > chunkSize) {
    await uploadOneResumable(file, chunkSize);
    return;
  }

  await uploadOneSingle(file);
}

function uploadOneSingle(file) {
  return new Promise((resolve) => {
    const card = createProgressCard(file.name);
    const request = new XMLHttpRequest();
    const startedAt = Date.now();

    request.open("POST", "/api/upload");
    request.setRequestHeader("X-File-Name", encodeURIComponent(file.name));
    if (state.pin) {
      request.setRequestHeader("X-Transfer-Pin", state.pin);
    }

    request.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) {
        const percent = Math.round((event.loaded / event.total) * 100);
        const elapsedSeconds = Math.max((Date.now() - startedAt) / 1000, 0.1);
        const speed = event.loaded / elapsedSeconds;
        const remainingSeconds = speed > 0 ? (event.total - event.loaded) / speed : 0;

        card.fill.style.width = `${percent}%`;
        card.status.textContent = `${percent}% - ${formatBytes(speed)}/s - ${formatDuration(remainingSeconds)} left`;
      }
    });

    request.addEventListener("load", () => {
      const ok = request.status >= 200 && request.status < 300;
      let body = {};
      try {
        body = JSON.parse(request.responseText || "{}");
      } catch {
        body = {};
      }
      card.fill.style.width = ok ? "100%" : "0";
      card.status.textContent = ok ? "Uploaded" : body.error || "Upload failed";
      card.root.classList.toggle("error", !ok);
      setTimeout(() => card.root.remove(), ok ? 1200 : 5000);
      resolve();
    });

    request.addEventListener("error", () => {
      card.status.textContent = "Network error";
      card.root.classList.add("error");
      setTimeout(() => card.root.remove(), 5000);
      resolve();
    });

    request.send(file);
  });
}

async function uploadOneResumable(file, preferredChunkSize) {
  const card = createProgressCard(file.name);
  const startedAt = Date.now();
  let uploadId = null;

  try {
    const session = await requestJson("/api/uploads/resumable/init", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: file.name, size: file.size })
    });

    uploadId = session.uploadId;
    const chunkSize = Math.min(session.chunkSize || preferredChunkSize, preferredChunkSize);
    let offset = session.receivedBytes || 0;

    while (offset < file.size) {
      const chunk = file.slice(offset, Math.min(offset + chunkSize, file.size));
      let result;
      try {
        result = await uploadChunkWithRetries(uploadId, offset, chunk);
      } catch (error) {
        if (error.status === 409) {
          const status = await requestJson(`/api/uploads/resumable/${uploadId}`);
          offset = status.receivedBytes;
          continue;
        }
        throw error;
      }
      offset = result.receivedBytes;
      updateProgressCard(card, offset, file.size, startedAt);

      if (result.complete) {
        card.fill.style.width = "100%";
        card.status.textContent = "Uploaded";
        setTimeout(() => card.root.remove(), 1200);
        return;
      }
    }
  } catch (error) {
    if (uploadId) {
      await requestJson(`/api/uploads/resumable/${uploadId}`, { method: "DELETE" }).catch(() => {});
    }
    card.fill.style.width = "0";
    card.status.textContent = error.message || "Upload failed";
    card.root.classList.add("error");
    setTimeout(() => card.root.remove(), 5000);
  }
}

async function uploadChunkWithRetries(uploadId, offset, chunk) {
  let lastError;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await requestJson(`/api/uploads/resumable/${uploadId}`, {
        method: "PATCH",
        headers: { "X-Upload-Offset": String(offset) },
        body: chunk
      });
    } catch (error) {
      lastError = error;
      if (error.status === 409) {
        throw error;
      }
      await delay(350 * (attempt + 1));
    }
  }

  throw lastError || new Error("Upload failed");
}

function updateProgressCard(card, loaded, total, startedAt) {
  const percent = Math.round((loaded / total) * 100);
  const elapsedSeconds = Math.max((Date.now() - startedAt) / 1000, 0.1);
  const speed = loaded / elapsedSeconds;
  const remainingSeconds = speed > 0 ? (total - loaded) / speed : 0;

  card.fill.style.width = `${percent}%`;
  card.status.textContent = `${percent}% - ${formatBytes(speed)}/s - ${formatDuration(remainingSeconds)} left`;
}

function createProgressCard(name) {
  const root = document.createElement("div");
  root.className = "progress-card";
  root.innerHTML = `
    <div class="progress-label">
      <span></span>
      <span></span>
    </div>
    <div class="progress-track"><div class="progress-fill"></div></div>
  `;
  const [label, status] = root.querySelectorAll(".progress-label span");
  label.textContent = name;
  status.textContent = "Starting";
  els.progressArea.prepend(root);
  return { root, fill: root.querySelector(".progress-fill"), status };
}

function renderFiles() {
  els.fileList.replaceChildren();
  els.fileCount.textContent = `${state.files.length} files`;
  els.emptyState.classList.toggle("hidden", state.files.length > 0);

  for (const file of state.files) {
    const node = els.fileTemplate.content.firstElementChild.cloneNode(true);
    const name = node.querySelector(".file-name");
    const meta = node.querySelector(".file-meta");
    const download = node.querySelector(".download-button");
    const remove = node.querySelector(".delete-button");

    name.textContent = file.name;
    meta.textContent = `${formatBytes(file.size)} · uploaded ${formatTime(file.uploadedAt)} · expires in ${formatRemaining(file.expiresAt)}`;
    download.addEventListener("click", () => downloadFile(file));
    remove.addEventListener("click", async () => deleteFile(file.id));

    els.fileList.append(node);
  }
}

async function deleteFile(id) {
  try {
    await requestJson(`/api/files/${id}`, { method: "DELETE" });
    await loadFiles();
  } catch (error) {
    showMessage(error.message || "Delete failed.", true);
  }
}

async function downloadFile(file) {
  if (file.downloadUrl) {
    const link = document.createElement("a");
    link.href = file.downloadUrl;
    link.download = file.name;
    document.body.append(link);
    link.click();
    link.remove();
    return;
  }

  try {
    const headers = new Headers();
    if (state.pin) {
      headers.set("X-Transfer-Pin", state.pin);
    }

    const response = await fetch(`/api/files/${file.id}/download`, {
      headers,
      cache: "no-store"
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || "Download failed.");
    }

    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = file.name;
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(objectUrl);
  } catch (error) {
    showMessage(error.message || "Download failed.", true);
  }
}

async function requestJson(url, options = {}) {
  const headers = new Headers(options.headers || {});
  if (state.pin) {
    headers.set("X-Transfer-Pin", state.pin);
  }

  const response = await fetch(url, {
    ...options,
    headers,
    cache: "no-store"
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || "Request failed.");
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

function showMessage(message, isError = false) {
  const card = document.createElement("div");
  card.className = "progress-card";
  card.textContent = message;
  if (isError) {
    card.style.borderColor = "#f3b5ae";
    card.style.color = "#b42318";
  }
  els.progressArea.prepend(card);
  setTimeout(() => card.remove(), 4000);
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

function getResumableChunkSize() {
  const mb = Number(state.config?.resumableChunkMb || 8);
  return Math.max(1, Math.floor(mb * 1024 * 1024));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return "0s";
  }
  const rounded = Math.ceil(seconds);
  if (rounded < 60) {
    return `${rounded}s`;
  }
  const minutes = Math.floor(rounded / 60);
  const remainder = rounded % 60;
  if (minutes < 60) {
    return `${minutes}m ${remainder}s`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function formatRemaining(value) {
  const seconds = Math.max(0, (value - Date.now()) / 1000);
  if (seconds <= 0) {
    return "expired";
  }
  return formatDuration(seconds);
}

function formatTime(value) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

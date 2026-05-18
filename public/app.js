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
  await loadConfig();
  await loadFiles();
  setInterval(loadFiles, 30 * 1000);
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
    els.configText.textContent = `默认保留 ${config.ttlHours} 小时，单个文件最大 ${config.maxFileMb} MB。`;
    els.uploadHint.textContent = `上传后 ${config.ttlHours} 小时自动过期，也可以手动删除。`;
    els.pinPanel.classList.toggle("hidden", !config.pinRequired);
  } catch (error) {
    showMessage(error.message || "配置读取失败。", true);
    if (error.status === 401) {
      els.pinPanel.classList.remove("hidden");
      els.configText.textContent = "请输入访问 PIN 后继续。";
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
      els.configText.textContent = "请输入访问 PIN 后继续。";
      return;
    }
    showMessage(error.message || "文件列表读取失败。", true);
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

function uploadOne(file) {
  return new Promise((resolve) => {
    const card = createProgressCard(file.name);
    const request = new XMLHttpRequest();

    request.open("POST", "/api/upload");
    request.setRequestHeader("X-File-Name", encodeURIComponent(file.name));
    if (state.pin) {
      request.setRequestHeader("X-Transfer-Pin", state.pin);
    }

    request.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) {
        const percent = Math.round((event.loaded / event.total) * 100);
        card.fill.style.width = `${percent}%`;
        card.status.textContent = `${percent}%`;
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
      card.status.textContent = ok ? "完成" : body.error || "上传失败";
      card.root.classList.toggle("error", !ok);
      setTimeout(() => card.root.remove(), ok ? 1200 : 5000);
      resolve();
    });

    request.addEventListener("error", () => {
      card.status.textContent = "网络错误";
      setTimeout(() => card.root.remove(), 5000);
      resolve();
    });

    request.send(file);
  });
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
  status.textContent = "准备上传";
  els.progressArea.prepend(root);
  return { root, fill: root.querySelector(".progress-fill"), status };
}

function renderFiles() {
  els.fileList.replaceChildren();
  els.fileCount.textContent = `${state.files.length} 个`;
  els.emptyState.classList.toggle("hidden", state.files.length > 0);

  for (const file of state.files) {
    const node = els.fileTemplate.content.firstElementChild.cloneNode(true);
    const name = node.querySelector(".file-name");
    const meta = node.querySelector(".file-meta");
    const download = node.querySelector(".download-button");
    const remove = node.querySelector(".delete-button");

    name.textContent = file.name;
    meta.textContent = `${formatBytes(file.size)} · ${formatTime(file.uploadedAt)} 上传 · ${formatTime(file.expiresAt)} 过期`;
    download.addEventListener("click", async () => {
      await downloadFile(file);
    });
    remove.addEventListener("click", async () => {
      await deleteFile(file.id);
    });

    els.fileList.append(node);
  }
}

async function deleteFile(id) {
  try {
    await requestJson(`/api/files/${id}`, { method: "DELETE" });
    await loadFiles();
  } catch (error) {
    showMessage(error.message || "删除失败。", true);
  }
}

async function downloadFile(file) {
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
      throw new Error(body.error || "下载失败。");
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
    showMessage(error.message || "下载失败。", true);
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
    const error = new Error(body.error || "请求失败。");
    error.status = response.status;
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

function formatTime(value) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

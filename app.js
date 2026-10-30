const $ = (selector) => document.querySelector(selector);
const sourceBody = $("#source-table-body");
const batchBody = $("#run-table-body");
const toast = $("#toast");
const drawerBackdrop = $("#drawer-backdrop");
let sources = [];
let batches = [];
let toastTimer;
const errorStageLabels = { collection: "获取阶段", parse: "解析阶段", validation: "校验阶段", export: "文件保存阶段" };

function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}

function localDateKey(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers }
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.message || `请求失败 (${response.status})`);
  return result.data;
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("show");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove("show"), 2800);
}

function updateSummaries() {
  const healthy = sources.filter((source) => source.status === "stable").length;
  $("#total-sources").textContent = String(sources.length).padStart(2, "0");
  $("#healthy-sources").textContent = String(healthy).padStart(2, "0");
  $("#attention-sources").textContent = String(sources.length - healthy).padStart(2, "0");
  $("#source-nav-count").textContent = String(sources.length).padStart(2, "0");
  $("#run-nav-count").textContent = String(batches.length).padStart(2, "0");

  const today = localDateKey();
  const todayBatches = batches.filter((batch) => batch.receivedAt?.startsWith(today));
  $("#today-runs").textContent = String(todayBatches.length).padStart(2, "0");
  $("#success-runs").textContent = todayBatches.reduce((sum, batch) => sum + batch.count, 0).toLocaleString("en-US");
  $("#partial-runs").textContent = String(todayBatches.filter((batch) => batch.errors.length).length).padStart(2, "0");
  $("#failed-runs").textContent = String(todayBatches.reduce((sum, batch) => sum + batch.errors.length, 0)).padStart(2, "0");

  const lastSuccess = sources.map((source) => source.lastReceived).filter((value) => value).sort().at(-1);
  $("#global-last-success").textContent = lastSuccess || "暂无批次接收记录";
}

async function loadData() {
  try {
    const [sourceData, batchData] = await Promise.all([api("/api/sources"), api("/api/batches")]);
    sources = sourceData;
    batches = batchData;
    updateSummaries();
    renderSources();
    renderBatches();
  } catch (error) {
    showToast(`无法读取数据接口：${error.message}`);
  }
}

function renderSources() {
  const query = $("#source-search").value.trim().toLocaleLowerCase();
  const status = $("#source-status-filter").value;
  const domain = $("#source-domain-filter").value;
  const country = $("#source-country-filter").value;
  const visible = sources.filter((source) => {
    const searchable = `${source.name} ${source.source}`.toLocaleLowerCase();
    return (status === "all" || source.status === status)
      && (domain === "all" || source.domain === domain)
      && (country === "all" || source.countries.includes(country))
      && (!query || searchable.includes(query));
  });

  sourceBody.innerHTML = visible.map((source) => `
    <tr>
      <td><button class="source-link" type="button" data-source-id="${escapeHTML(source.id)}"><span class="source-monogram">${escapeHTML(source.name.slice(0, 1))}</span><span class="source-name-wrap"><strong>${escapeHTML(source.name)}</strong><small>${escapeHTML(source.source)}</small></span></button></td>
      <td><span class="domain-label">${escapeHTML(source.domain)}</span></td>
      <td>${source.countries.map((item) => `<span class="country-label">${escapeHTML(item)}</span>`).join(" ")}</td>
      <td><span class="status-pill source-status-${escapeHTML(source.status)}"><i></i>${escapeHTML(source.statusLabel)}</span></td>
      <td class="time-cell">${escapeHTML(source.lastReceived || "尚无入库批次")}</td>
      <td>${source.failuresSince ? `<button class="failure-count-link" type="button" data-source-failures="${escapeHTML(source.id)}">${source.failuresSince} 次失败 <span>查看原因</span></button>` : `<span class="failure-none">${source.status === "pending" ? "暂无记录" : "0 次"}</span>`}</td>
      <td class="row-action-cell"><button class="row-action" type="button" data-source-id="${escapeHTML(source.id)}" aria-label="查看${escapeHTML(source.name)}详情" title="查看详情">›</button></td>
    </tr>`).join("");

  $("#source-empty").hidden = visible.length > 0;
  $("#source-result-count").textContent = `共 ${visible.length} 个信息员`;
  sourceBody.querySelectorAll("[data-source-id]").forEach((button) => button.addEventListener("click", () => openSource(button.dataset.sourceId)));
  sourceBody.querySelectorAll("[data-source-failures]").forEach((button) => button.addEventListener("click", () => openSourceFailures(button.dataset.sourceFailures)));
}

function renderBatches() {
  const query = $("#run-search").value.trim().toLocaleLowerCase();
  const sourceId = $("#batch-source-filter").value;
  const dateRange = $("#run-date-filter").value;
  const today = localDateKey();
  const visible = batches.filter((batch) => {
    const searchable = `${batch.source} ${batch.sourceName} ${batch.id} ${batch.errors.map((error) => `${error.id} ${error.description}`).join(" ")}`.toLocaleLowerCase();
    return (sourceId === "all" || batch.sourceId === sourceId)
      && (dateRange === "all" || batch.receivedAt?.startsWith(today))
      && (!query || searchable.includes(query));
  });

  batchBody.innerHTML = visible.map((batch) => `
    <tr>
      <td><button class="run-link" type="button" data-batch-id="${escapeHTML(batch.id)}"><strong>${escapeHTML(batch.source)}</strong><small>${escapeHTML(batch.id)}</small></button></td>
      <td class="time-cell"><span>${escapeHTML(batch.receivedAt)}</span><small class="cell-subtext">${escapeHTML(batch.fileName || "JSON 批次")}</small></td>
      <td><span class="domain-label">${escapeHTML(batch.domain)}</span></td>
      <td class="number-cell">${batch.recordCount.toLocaleString("en-US")} <span class="unit-label">条</span></td>
      <td>${batch.errors.length ? `<button class="error-count-link" type="button" data-batch-id="${escapeHTML(batch.id)}">${batch.errors.length} 条</button>` : `<span class="no-batch-errors">0 条</span>`}</td>
      <td class="error-cell ${batch.errors.length ? "has-error" : ""}">${batch.errors.length ? `<button class="error-summary-link" type="button" data-batch-id="${escapeHTML(batch.id)}">${escapeHTML(batch.errors[0].description)}</button>` : `<span class="no-batch-errors">—</span>`}</td>
      <td class="row-action-cell"><button class="row-action" type="button" data-batch-id="${escapeHTML(batch.id)}" aria-label="查看批次详情" title="查看批次详情">›</button></td>
    </tr>`).join("");

  $("#run-empty").hidden = visible.length > 0;
  $("#run-result-count").textContent = `共 ${visible.length} 个批次`;
  batchBody.querySelectorAll("[data-batch-id]").forEach((button) => button.addEventListener("click", () => openBatch(button.dataset.batchId)));
}

function detailRow(label, value) {
  return `<div class="detail-row"><dt>${escapeHTML(label)}</dt><dd>${escapeHTML(value)}</dd></div>`;
}

function openDrawer(title, kicker, content) {
  $("#drawer-title").textContent = title;
  $("#drawer-kicker").textContent = kicker;
  $("#drawer-content").innerHTML = content;
  drawerBackdrop.hidden = false;
  $("#drawer-close").focus();
}

async function openSource(sourceId) {
  try {
    const source = await api(`/api/sources/${encodeURIComponent(sourceId)}`);
    const recentBatches = await api(`/api/sources/${encodeURIComponent(sourceId)}/batches?limit=3`);
    openDrawer(source.name, "SOURCE PROFILE · API DATA", `
      <div class="drawer-status"><span class="status-pill source-status-${escapeHTML(source.status)}"><i></i>${escapeHTML(source.statusLabel)}</span><span class="demo-inline">本地 API</span></div>
      <div class="drawer-section"><h3>来源信息</h3><dl class="detail-list">
        ${detailRow("信息员名称", source.name)}${detailRow("外部来源", source.source)}${detailRow("提供的信息领域", source.domain)}${detailRow("国家 / 地区", source.countries.join("、"))}${detailRow("采集方式", `${source.method} · ${source.cadence}`)}${detailRow("维护方", source.owner)}${detailRow("最近传入数据", source.lastReceived || "尚无入库批次")}${detailRow("最近成功之后失败次数", `${source.failuresSince} 次`)}
      </dl></div>
    <div class="drawer-section"><h3>最近接收批次</h3>${recentBatches.length ? `<div class="mini-batch-list">${recentBatches.map((batch) => `<div><span>${escapeHTML(batch.receivedAt)}</span><strong>${batch.recordCount.toLocaleString("en-US")} 条</strong></div>`).join("")}</div>` : `<div class="empty-inline">尚无批次记录</div>`}</div>
      <div class="drawer-callout"><strong>说明</strong><p>${escapeHTML(source.note)}</p></div>`);
  } catch (error) { showToast(`来源详情读取失败：${error.message}`); }
}

async function openSourceFailures(sourceId) {
  try {
    const result = await api(`/api/sources/${encodeURIComponent(sourceId)}/failures`);
    const items = result.failures.map((error) => `<article class="failure-detail-item"><div><strong>${escapeHTML(error.id)}</strong><time>${escapeHTML(error.time)}</time></div><p>${escapeHTML(error.description)}</p></article>`).join("");
    openDrawer(`${result.sourceName} · 失败原因`, "FAILURES SINCE LAST INGESTION", `
      <div class="drawer-status"><span class="status-pill source-status-error"><i></i>${result.failuresSince} 次失败</span><span class="demo-inline">本地 API</span></div>
      <div class="drawer-section"><h3>失败记录</h3><div class="failure-list">${items || `<div class="empty-inline">没有失败记录</div>`}</div></div>
      <div class="drawer-callout"><strong>计数口径</strong><p>失败次数从最近一次成功入库后开始累计。每次失败保留独立错误 ID 和可读原因。</p></div>`);
  } catch (error) { showToast(`失败详情读取失败：${error.message}`); }
}

async function openBatch(batchId) {
  try {
    const batch = await api(`/api/batches/${encodeURIComponent(batchId)}`);
    const errors = batch.errors.length
      ? `<div class="failure-list">${batch.errors.map((error) => `<article class="failure-detail-item"><div><strong>${escapeHTML(error.id)}</strong><time>${escapeHTML(errorStageLabels[error.stage] || error.stage)} · 影响 ${error.affectedCount === null ? "未知" : `${error.affectedCount} 条`}</time></div><p>${escapeHTML(error.description)}</p></article>`).join("")}</div>`
      : `<div class="no-error"><i></i>该批次没有记录错误</div>`;
    openDrawer("数据批次详情", "BATCH DETAIL · API DATA", `
      <div class="drawer-status"><span class="status-pill ${batch.errors.length ? "run-status-partial" : "run-status-success"}"><i></i>${batch.errors.length ? `${batch.errors.length} 条错误` : "无错误"}</span><span class="run-id">${escapeHTML(batch.id)}</span></div>
      <div class="drawer-section"><h3>批次信息</h3><dl class="detail-list">
        ${detailRow("信息员名称", batch.source)}${detailRow("外部来源", batch.sourceName)}${detailRow("信息领域", batch.domain)}${detailRow("采集完成时间", batch.collectedAt)}${detailRow("批次接收时间", batch.receivedAt)}${detailRow("数据文件", batch.fileName || "JSON 批次数据")}${detailRow("获取条数", `${batch.fetchedCount.toLocaleString("en-US")} 条`)}${detailRow("文件记录条数", `${batch.recordCount.toLocaleString("en-US")} 条`)}${detailRow("批次状态", batch.status)}${detailRow("错误数量", `${batch.errors.length} 条`)}
      </dl></div>
      <div class="drawer-section"><h3>错误详情</h3>${errors}</div>
      <div class="drawer-callout"><strong>批次标识</strong><p>批次编号与接收时间由平台生成。采集完成时间由数据组提供；此阶段是文件交接登记，不代表数据库入库。</p></div>`);
  } catch (error) { showToast(`批次详情读取失败：${error.message}`); }
}

function closeDrawer() { drawerBackdrop.hidden = true; }

function switchPage(page) {
  const isSources = page === "sources";
  $("#sources-page").hidden = !isSources;
  $("#runs-page").hidden = isSources;
  $("#breadcrumb-current").textContent = isSources ? "数据来源" : "数据批次";
  document.querySelectorAll(".nav-item").forEach((button) => {
    const active = button.dataset.page === page;
    button.classList.toggle("active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  history.replaceState(null, "", `#${page}`);
}

$("#source-search").addEventListener("input", renderSources);
$("#source-domain-filter").addEventListener("change", renderSources);
$("#source-country-filter").addEventListener("change", renderSources);
$("#source-status-filter").addEventListener("change", renderSources);
$("#run-search").addEventListener("input", renderBatches);
$("#batch-source-filter").addEventListener("change", renderBatches);
$("#run-date-filter").addEventListener("change", renderBatches);
document.querySelectorAll("[data-page]").forEach((button) => button.addEventListener("click", () => switchPage(button.dataset.page)));
$("#source-info-button").addEventListener("click", () => showToast("来源和批次数据现通过本地 HTTP API 读取。"));
$("#refresh-button").addEventListener("click", loadData);
$("#drawer-close").addEventListener("click", closeDrawer);
drawerBackdrop.addEventListener("click", (event) => { if (event.target === drawerBackdrop) closeDrawer(); });
document.addEventListener("keydown", (event) => { if (event.key === "Escape" && !drawerBackdrop.hidden) closeDrawer(); });

const initialPage = window.location.hash === "#batches" || window.location.hash === "#runs" ? "batches" : "sources";
switchPage(initialPage);
loadData();

import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const root = fileURLToPath(new URL(".", import.meta.url));
const storageRoot = process.env.DATA_DIR || root;
const dataPath = join(storageRoot, "data.json");
const seedDataPath = join(root, "data.json");
const uploadPath = join(storageRoot, "uploads");
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || "0.0.0.0";
const ingestApiKey = process.env.INGEST_API_KEY || "";
const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

let writeQueue = Promise.resolve();

function localTimestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

async function loadData() {
  let rawData;
  try {
    rawData = await readFile(dataPath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    rawData = await readFile(seedDataPath, "utf8");
    if (storageRoot !== root) {
      await mkdir(storageRoot, { recursive: true });
      await writeFile(dataPath, rawData, { flag: "wx" }).catch((writeError) => {
        if (writeError.code !== "EEXIST") throw writeError;
      });
    }
  }
  const data = JSON.parse(rawData);
  data.batches = data.batches.map((batch) => ({
    ...batch,
    receivedAt: batch.receivedAt || batch.ingestedAt || "",
    collectedAt: batch.collectedAt || batch.ingestedAt || "",
    recordCount: batch.recordCount ?? batch.count ?? 0,
    fetchedCount: batch.fetchedCount ?? batch.count ?? 0,
    status: batch.status || (batch.errors?.length ? "partial" : "success"),
    fileName: batch.fileName ?? null,
    errors: (batch.errors || []).map((error) => ({
      ...error,
      id: error.id || error.error_id,
      stage: error.stage || "validation",
      description: error.description || error.message || "",
      affectedCount: error.affectedCount ?? error.affected_count ?? null
    }))
  }));
  return data;
}

function saveData(data) {
  writeQueue = writeQueue.then(() => writeFile(dataPath, `${JSON.stringify(data, null, 2)}\n`));
  return writeQueue;
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify(payload));
}

function ok(response, data, status = 200) {
  sendJson(response, status, { data });
}

function fail(response, status, code, message) {
  sendJson(response, status, { error: { code, message } });
}

async function readBody(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 1_000_000) throw new Error("请求内容不能超过 1 MB");
  }
  try {
    return JSON.parse(body || "{}");
  } catch {
    throw new Error("请求体必须是合法 JSON");
  }
}

async function readRawBody(request, limit = 10_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error("上传内容不能超过 10 MB");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function countCsvRecords(csv) {
  let rows = 0;
  let inQuotes = false;
  for (let index = 0; index < csv.length; index += 1) {
    if (csv[index] === '"') {
      if (inQuotes && csv[index + 1] === '"') index += 1;
      else inQuotes = !inQuotes;
    } else if (!inQuotes && csv[index] === "\n") {
      rows += 1;
    }
  }
  if (inQuotes) throw new Error("CSV 文件存在未闭合的引号");
  const lines = csv.trimEnd().split(/\r?\n/);
  if (lines.length === 0 || !lines[0].trim()) throw new Error("CSV 文件缺少表头");
  return Math.max(0, rows - (csv.endsWith("\n") ? 1 : 0));
}

function firstCsvRow(csv) {
  const cells = [];
  let cell = "";
  let inQuotes = false;
  for (let index = 0; index < csv.length; index += 1) {
    const character = csv[index];
    if (character === '"') {
      if (inQuotes && csv[index + 1] === '"') { cell += '"'; index += 1; }
      else inQuotes = !inQuotes;
    } else if (character === "," && !inQuotes) {
      cells.push(cell.trim());
      cell = "";
    } else if ((character === "\n" || character === "\r") && !inQuotes) {
      if (character === "\r" && csv[index + 1] === "\n") index += 1;
      cells.push(cell.trim());
      return cells;
    } else {
      cell += character;
    }
  }
  cells.push(cell.trim());
  return cells;
}

function validateBatchEnvelope(body, source) {
  const problems = [];
  if (body.schema_version !== "1.0") problems.push("schema_version 必须是 1.0");
  if (body.source_id !== source.id) problems.push("source_id 必须对应已登记的数据来源");
  if (body.domain !== source.domain) problems.push("domain 与来源登记信息不一致");
  if (!Array.isArray(body.countries) || body.countries.length === 0 || body.countries.some((code) => typeof code !== "string" || !/^[A-Z]{3}$/.test(code))) {
    problems.push("countries 必须是 ISO alpha-3 国家代码数组");
  }
  if (!body.collected_at || Number.isNaN(Date.parse(body.collected_at)) || !/(Z|[+-]\d{2}:\d{2})$/.test(body.collected_at)) {
    problems.push("collected_at 必须是带时区的 ISO 时间");
  }
  if (!["success", "partial", "failed"].includes(body.status)) problems.push("status 必须是 success、partial 或 failed");
  if (!isNonNegativeInteger(body.fetched_count)) problems.push("fetched_count 必须是非负整数");
  if (!Array.isArray(body.records)) problems.push("records 必须是数组");
  else if (body.record_count !== body.records.length) problems.push("record_count 必须与 records 数组长度一致");
  if (!Array.isArray(body.errors)) problems.push("errors 必须是数组");
  else body.errors.forEach((item, index) => {
    if (!item || typeof item !== "object") {
      problems.push(`errors[${index}] 必须是对象`);
      return;
    }
    if (typeof item.error_id !== "string" || !item.error_id.trim()) problems.push(`errors[${index}].error_id 必须是非空文本`);
    if (!["collection", "parse", "validation", "export"].includes(item.stage)) problems.push(`errors[${index}].stage 值无效`);
    if (typeof item.message !== "string" || !item.message.trim()) problems.push(`errors[${index}].message 必须是非空文本`);
    if (item.affected_count !== null && !isNonNegativeInteger(item.affected_count)) problems.push(`errors[${index}].affected_count 必须是非负整数或 null`);
  });
  if (body.status === "failed" && Array.isArray(body.errors) && body.errors.length === 0) problems.push("failed 批次至少需要一条错误说明");

  const records = Array.isArray(body.records) ? body.records : [];
  if (source.id === "world-bank") records.forEach((record, index) => {
    if (record.record_type !== "macro_indicator" || !/^[A-Z]{3}$/.test(record.country_code || "") || typeof record.indicator_code !== "string" || !Number.isInteger(record.year) || (record.value !== null && typeof record.value !== "number") || typeof record.unit !== "string") {
      problems.push(`records[${index}] 不是有效的世界银行宏观指标记录`);
    }
  });
  if (source.id === "comtrade") records.forEach((record, index) => {
    if (record.record_type !== "bilateral_trade" || !/^[A-Z]{3}$/.test(record.reporter_code || "") || !/^[A-Z]{3}$/.test(record.partner_code || "") || !Number.isInteger(record.year) || !["import", "export"].includes(record.flow) || typeof record.commodity_code !== "string" || typeof record.commodity_classification !== "string" || typeof record.trade_value !== "number" || typeof record.currency !== "string") {
      problems.push(`records[${index}] 不是有效的 UN Comtrade 双边贸易记录`);
    }
  });
  return problems;
}

function parseMultipart(contentType, buffer) {
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!boundaryMatch) throw new Error("multipart 请求缺少 boundary");
  const boundary = Buffer.from(`--${(boundaryMatch[1] || boundaryMatch[2]).trim()}`);
  const chunks = buffer.toString("latin1").split(boundary.toString("latin1"));
  const fields = {};
  for (const chunk of chunks) {
    const separator = chunk.indexOf("\r\n\r\n");
    if (separator < 0) continue;
    const headers = chunk.slice(0, separator);
    let value = chunk.slice(separator + 4).replace(/\r\n--?\s*$/, "").replace(/\r\n$/, "");
    const name = headers.match(/name="([^"]+)"/i)?.[1];
    const filename = headers.match(/filename="([^"]+)"/i)?.[1];
    if (!name) continue;
    if (filename) fields[name] = { filename: basename(filename), content: Buffer.from(value, "latin1") };
    else fields[name] = value;
  }
  return fields;
}

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function getSource(data, sourceId) {
  return data.sources.find((source) => source.id === sourceId);
}

function requireIngestKey(request, response) {
  if (!ingestApiKey) {
    if (process.env.NODE_ENV === "production") {
      fail(response, 503, "INGEST_KEY_NOT_CONFIGURED", "服务端尚未配置上报密钥");
      return false;
    }
    return true;
  }
  if (request.headers["x-ingest-key"] !== ingestApiKey) {
    fail(response, 401, "INVALID_INGEST_KEY", "上报密钥无效或缺失");
    return false;
  }
  return true;
}

async function handleApi(request, response, url) {
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const method = request.method || "GET";
  const data = await loadData();

  if (method === "GET" && parts.join("/") === "api/health") {
    return ok(response, { status: "ok", storage: "local-json-file" });
  }

  if (method === "GET" && parts.join("/") === "api/sources") {
    return ok(response, data.sources);
  }

  if (method === "GET" && parts[0] === "api" && parts[1] === "sources" && parts.length === 3) {
    const source = getSource(data, parts[2]);
    return source ? ok(response, source) : fail(response, 404, "SOURCE_NOT_FOUND", "找不到该数据来源");
  }

  if (method === "GET" && parts[0] === "api" && parts[1] === "sources" && parts[3] === "failures") {
    const source = getSource(data, parts[2]);
    return source
      ? ok(response, { sourceId: source.id, sourceName: source.name, failuresSince: source.failuresSince, failures: source.failureDetails })
      : fail(response, 404, "SOURCE_NOT_FOUND", "找不到该数据来源");
  }

  if (method === "GET" && parts[0] === "api" && parts[1] === "sources" && parts[3] === "batches") {
    const source = getSource(data, parts[2]);
    if (!source) return fail(response, 404, "SOURCE_NOT_FOUND", "找不到该数据来源");
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 20), 1), 100);
    return ok(response, data.batches.filter((batch) => batch.sourceId === source.id).sort((a, b) => b.receivedAt.localeCompare(a.receivedAt)).slice(0, limit).map(({ records, ...batch }) => batch));
  }

  if (method === "GET" && parts.join("/") === "api/batches") {
    return ok(response, data.batches.map(({ records, ...batch }) => batch).sort((a, b) => b.receivedAt.localeCompare(a.receivedAt)));
  }

  if (method === "GET" && parts[0] === "api" && parts[1] === "batches" && parts.length === 3) {
    const batch = data.batches.find((item) => item.id === parts[2]);
    if (!batch) return fail(response, 404, "BATCH_NOT_FOUND", "找不到该数据批次");
    const { records, ...metadata } = batch;
    return ok(response, metadata);
  }

  if (method === "GET" && parts[0] === "api" && parts[1] === "batches" && parts[3] === "records") {
    const batch = data.batches.find((item) => item.id === parts[2]);
    if (!batch) return fail(response, 404, "BATCH_NOT_FOUND", "找不到该数据批次");
    if (!Array.isArray(batch.records)) return fail(response, 409, "RECORDS_NOT_INLINE", "此批次使用 CSV 文件保存，请使用批次文件下载接口");
    const offset = Math.max(0, Number(url.searchParams.get("offset") || 0));
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 100), 1), 500);
    return ok(response, { batchId: batch.id, total: batch.records.length, offset, records: batch.records.slice(offset, offset + limit) });
  }

  if (method === "GET" && parts[0] === "api" && parts[1] === "batches" && parts[3] === "file") {
    const batch = data.batches.find((item) => item.id === parts[2]);
    if (!batch) return fail(response, 404, "BATCH_NOT_FOUND", "找不到该数据批次");
    if (!batch.storedFile) return fail(response, 409, "NO_STORED_FILE", "该 JSON 批次没有单独的 CSV 文件");
    try {
      const contents = await readFile(join(uploadPath, batch.storedFile));
      response.writeHead(200, { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(batch.fileName)}` });
      response.end(contents);
    } catch {
      return fail(response, 404, "FILE_NOT_FOUND", "批次文件不存在");
    }
    return;
  }

  if (method === "POST" && parts.join("/") === "api/batches") {
    if (!requireIngestKey(request, response)) return;
    const body = await readBody(request);
    const source = getSource(data, body.source_id);
    if (!source) return fail(response, 422, "INVALID_SOURCE", "source_id 必须对应已登记的数据来源");
    if (source.status === "paused") return fail(response, 422, "SOURCE_PAUSED", "该来源已暂停接收批次");
    const problems = validateBatchEnvelope(body, source);
    if (problems.length) return sendJson(response, 422, { error: { code: "INVALID_BATCH", message: "批次不符合交接规范", details: problems } });

    const receivedAt = localTimestamp();
    const batch = {
      id: `B-${localTimestamp().replace(/[-: ]/g, "")}-${randomUUID().slice(0, 6)}`,
      sourceId: source.id,
      source: source.name,
      sourceName: source.source,
      domain: source.domain,
      countries: body.countries,
      collectedAt: body.collected_at,
      receivedAt,
      status: body.status,
      fetchedCount: body.fetched_count,
      recordCount: body.record_count,
      count: body.record_count,
      errors: body.errors.map((item) => ({ id: item.error_id, stage: item.stage, description: item.message, affectedCount: item.affected_count })),
      records: body.records,
      fileName: null,
      fileFormat: "json"
    };

    data.batches.unshift(batch);
    if (body.status !== "failed") {
      source.lastReceived = receivedAt;
      source.failuresSince = 0;
      source.failureDetails = [];
      source.status = body.status === "partial" ? "error" : "stable";
      source.statusLabel = body.status === "partial" ? "部分异常" : "运行正常";
    } else {
      source.failuresSince += 1;
      source.status = "error";
      source.statusLabel = "有采集失败";
      source.failureDetails.unshift(...batch.errors.map((item) => ({ id: item.id, time: receivedAt, description: item.description })));
    }
    await saveData(data);
    return ok(response, batch, 201);
  }

  if (method === "POST" && parts.join("/") === "api/batches/csv") {
    if (!requireIngestKey(request, response)) return;
    const fields = parseMultipart(request.headers["content-type"] || "", await readRawBody(request));
    if (!fields.manifest || !fields.file) return fail(response, 422, "MISSING_UPLOAD_PARTS", "请同时上传 manifest 和 CSV 文件");
    let manifest;
    try { manifest = JSON.parse(fields.manifest); }
    catch { return fail(response, 422, "INVALID_MANIFEST", "manifest 必须是合法 JSON"); }
    const source = getSource(data, manifest.source_id);
    if (!source) return fail(response, 422, "INVALID_SOURCE", "manifest.source_id 必须对应已登记的数据来源");
    if (source.status === "paused") return fail(response, 422, "SOURCE_PAUSED", "该来源已暂停接收批次");
    const problems = validateBatchEnvelope({ ...manifest, records: [], record_count: 0 }, source).filter((problem) => !problem.startsWith("record_count"));
    if (problems.length) return sendJson(response, 422, { error: { code: "INVALID_MANIFEST", message: "Manifest 不符合交接规范", details: problems } });
    if (manifest.file_format !== "csv" || !fields.file.filename.toLowerCase().endsWith(".csv")) return fail(response, 422, "INVALID_FILE_FORMAT", "文件必须是 CSV，manifest.file_format 必须为 csv");
    if (manifest.file_name && manifest.file_name !== fields.file.filename) return fail(response, 422, "FILE_NAME_MISMATCH", "Manifest.file_name 与上传文件名不一致");
    const csv = fields.file.content.toString("utf8").replace(/^\uFEFF/, "");
    let actualCount;
    try { actualCount = countCsvRecords(csv); }
    catch (error) { return fail(response, 422, "INVALID_CSV", error.message); }
    if (manifest.record_count !== actualCount) return sendJson(response, 422, { error: { code: "RECORD_COUNT_MISMATCH", message: "Manifest 行数与 CSV 实际记录数不一致", details: [`manifest: ${manifest.record_count}`, `actual: ${actualCount}`] } });
    const headers = firstCsvRow(csv);
    const requiredHeaders = source.id === "world-bank"
      ? ["country_code", "indicator_code", "indicator_name", "year", "value", "unit"]
      : source.id === "comtrade"
        ? ["reporter_code", "partner_code", "year", "flow", "commodity_code", "commodity_name", "commodity_classification", "trade_value", "currency"]
        : [];
    const missingHeaders = requiredHeaders.filter((header) => !headers.includes(header));
    if (missingHeaders.length) return sendJson(response, 422, { error: { code: "CSV_SCHEMA_MISMATCH", message: "CSV 缺少该数据源的必需字段", details: missingHeaders } });

    await mkdir(uploadPath, { recursive: true });
    const storedName = `${Date.now()}-${randomUUID().slice(0, 8)}-${fields.file.filename}`;
    await writeFile(join(uploadPath, storedName), fields.file.content, { flag: "wx" });
    const receivedAt = localTimestamp();
    const batch = {
      id: `B-${localTimestamp().replace(/[-: ]/g, "")}-${randomUUID().slice(0, 6)}`,
      sourceId: source.id,
      source: source.name,
      sourceName: source.source,
      domain: source.domain,
      countries: manifest.countries,
      collectedAt: manifest.collected_at,
      receivedAt,
      status: manifest.status,
      fetchedCount: manifest.fetched_count,
      recordCount: actualCount,
      count: actualCount,
      errors: manifest.errors.map((item) => ({ id: item.error_id, stage: item.stage, description: item.message, affectedCount: item.affected_count })),
      records: null,
      fileName: fields.file.filename,
      fileFormat: "csv",
      storedFile: storedName
    };
    data.batches.unshift(batch);
    if (manifest.status !== "failed") {
      source.lastReceived = receivedAt;
      source.failuresSince = 0;
      source.failureDetails = [];
      source.status = manifest.status === "partial" ? "error" : "stable";
      source.statusLabel = manifest.status === "partial" ? "部分异常" : "运行正常";
    }
    await saveData(data);
    const { records, ...batchMetadata } = batch;
    return ok(response, batchMetadata, 201);
  }

  if (method === "POST" && parts.join("/") === "api/failures") {
    if (!requireIngestKey(request, response)) return;
    const body = await readBody(request);
    const source = getSource(data, body.sourceId);
    if (!source) return fail(response, 422, "INVALID_SOURCE", "sourceId 必须对应已登记的数据来源");
    if (!body.description || typeof body.description !== "string") return fail(response, 422, "INVALID_DESCRIPTION", "description 必须是非空文本");

    const failure = {
      id: String(body.errorId || `ERR-${randomUUID().slice(0, 8).toUpperCase()}`),
      time: body.occurredAt || localTimestamp(),
      description: body.description
    };
    source.failureDetails.unshift(failure);
    source.failuresSince += 1;
    source.status = "error";
    source.statusLabel = "有采集失败";
    await saveData(data);
    return ok(response, { sourceId: source.id, failuresSince: source.failuresSince, failure }, 201);
  }

  return fail(response, 404, "ROUTE_NOT_FOUND", "接口不存在");
}

async function serveStatic(request, response, url) {
  const requestedPath = url.pathname === "/" ? "/index.html" : url.pathname;
  if (requestedPath.startsWith("/uploads/")) return fail(response, 404, "FILE_NOT_FOUND", "上传文件不通过静态服务公开");
  const safePath = normalize(decodeURIComponent(requestedPath)).replace(/^([/\\]|\.\.(?:[/\\]|$))+/, "");
  const filePath = join(root, safePath);
  if (!filePath.startsWith(root)) return fail(response, 403, "FORBIDDEN", "禁止访问该路径");

  try {
    const contents = await readFile(filePath);
    response.writeHead(200, { "Content-Type": mimeTypes[extname(filePath)] || "application/octet-stream" });
    response.end(contents);
  } catch {
    fail(response, 404, "FILE_NOT_FOUND", "找不到文件");
  }
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);
    if (url.pathname.startsWith("/api/")) await handleApi(request, response, url);
    else await serveStatic(request, response, url);
  } catch (error) {
    fail(response, 400, "BAD_REQUEST", error.message || "请求无法处理");
  }
});

server.listen(port, host, () => {
  console.log(`Data operations service listening on ${host}:${port}`);
  console.log(`Storage directory: ${storageRoot}`);
  console.log(`Ingest API key: ${ingestApiKey ? "configured" : "not configured (development only)"}`);
});

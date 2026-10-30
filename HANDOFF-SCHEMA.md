# 数据批次交接规范（讨论稿）

## 当前依据与边界

工作区内目前没有世界银行或 UN Comtrade 小组实际生成的 CSV/JSON 文件，因此本规范根据两组任务说明拟定，不能替代对真实样例文件的字段核对。请两组各提供一份成功样例和一份有错误的运行记录后再定稿。

两组统一的是**批次交接信息和错误表达**；业务记录字段按数据类型分别约定。宏观经济指标和国际贸易明细不是同一种记录，不能为了“统一”把字段揉成一张表。

## 文件交接方式

优先建议每批一个 JSON 文件，外层放批次信息，`records` 放业务数据。若小组更方便交 CSV，则同时提交一个同名 `.manifest.json` 文件记录批次信息、CSV 文件名和行数。文件名不是唯一标识，批次 ID 由接收平台登记时生成。

```text
world-bank-macro-2026-10-29.json
```

或：

```text
comtrade-cn-vn-2024.csv
comtrade-cn-vn-2024.manifest.json
```

## 共同批次格式

JSON 批次建议结构：

```json
{
  "schema_version": "1.0",
  "source_id": "world-bank",
  "source_name": "World Bank Indicators API",
  "domain": "经济",
  "countries": ["CHN", "VNM"],
  "collected_at": "2026-10-29T10:00:00+08:00",
  "status": "partial",
  "fetched_count": 120,
  "record_count": 112,
  "errors": [
    {
      "error_id": "WB-INDICATOR-001",
      "stage": "collection",
      "message": "失业率指标本次未获取到数据。",
      "affected_count": 8
    }
  ],
  "records": []
}
```

字段约定：

| 字段 | 含义 | 提供方 |
| --- | --- | --- |
| `schema_version` | 交接格式版本 | 数据平台组约定 |
| `source_id` | 平台登记的稳定来源 ID，不用临时改名 | 数据平台组分配，采集组填写 |
| `source_name` | 可读来源名称 | 采集组提供，平台校对 |
| `domain` | 信息领域，使用约定词表，如“经济”或“贸易与供应链” | 平台组维护，采集组填写 |
| `countries` | 本批覆盖国家的 ISO 3166-1 alpha-3 代码 | 采集组填写；未知覆盖须明确标记，不能猜 |
| `collected_at` | 采集任务完成时间，必须带时区 | 采集程序填写 |
| `status` | `success`、`partial` 或 `failed` | 采集程序按结果填写 |
| `fetched_count` | 上游返回/抓取到的记录数 | 采集程序填写；失败且无结果时为 0 |
| `record_count` | 文件中实际业务记录数，不含表头 | 接收方读取后复核；提交方可附报 |
| `errors` | 采集、解析、校验或文件导出阶段的错误 | 发生错误的一方填写 |
| `records` | 该来源的业务记录 | 对应数据组填写 |

平台收到文件的时间应由平台另行记录为 `received_at`；平台创建批次后生成 `batch_id`。不要让采集组手填这两个值。若 JSON 文件里先自行带上它们，平台也应以接收端记录为准。

错误对象的 `stage` 使用：`collection`（请求/抓取）、`parse`（解析）、`validation`（格式或字段检查）、`export`（写文件）。`error_id` 是本次错误的可追踪编号；`affected_count` 是受影响条数，未知时用 `null`，不要填 0 冒充已知。

## 两类业务记录字段

### 世界银行宏观指标

建议每条记录至少包含：

```json
{
  "record_type": "macro_indicator",
  "country_code": "CHN",
  "indicator_code": "NY.GDP.MKTP.CD",
  "indicator_name": "GDP (current US$)",
  "year": 2024,
  "value": 18300000000000,
  "unit": "current US$"
}
```

国家代码统一用 ISO alpha-3；指标代码应保留 World Bank 原始代码；数值字段保持数字类型，缺失值用 `null`，不要写字符串 `"N/A"`。通胀率等百分比指标应在 `unit` 中标清单位。

### UN Comtrade 双边贸易

建议每条记录至少包含：

```json
{
  "record_type": "bilateral_trade",
  "reporter_code": "CHN",
  "partner_code": "VNM",
  "year": 2024,
  "flow": "export",
  "commodity_code": "27",
  "commodity_name": "Mineral fuels",
  "commodity_classification": "HS",
  "trade_value": 1200000000,
  "currency": "USD"
}
```

报告国和伙伴国都用 ISO alpha-3；`flow` 统一使用 `import` 或 `export`，并保留报告国视角。商品编码需同时说明分类体系（如 HS）及可获得的版本/位数，避免不同粒度代码混淆；贸易金额为数字，并明确币种。

## CSV + Manifest 约定

CSV 只放业务记录，一行一条记录，UTF-8 编码、第一行为字段名。对应的 `.manifest.json` 使用上述共同批次字段，但不放 `records`，并增加：

```json
{
  "file_name": "comtrade-cn-vn-2024.csv",
  "file_format": "csv"
}
```

Manifest 的 `record_count` 应与 CSV 表头之后的数据行数一致。若不一致，接收方登记为批次校验错误，不静默修改原文件。

## 入库/登记口径

当前阶段先交文件，不接数据库。平台的时间叫 `received_at`（批次接收/登记时间），不是数据库入库时间；数据面板展示的批次条数是文件中的 `record_count`。今后真正导入数据库时，再增加独立的 `persisted_at` 和实际成功写入条数。

当前原型按本稿实现了完整 JSON 批次提交，以及 CSV + manifest 的本地上传：JSON 记录存入本地演示数据文件，CSV 原文件存入 `uploads/`，两种方式都由平台生成 `batch_id` 和 `received_at`。它仍是本机原型存储，不是数据库；CSV 目前校验表头和行数，不校验所有业务单元格。真实小组样例到达后，仍需核对并可能调整字段映射。

# Local Data Handoff API

Start the local service from this directory:

```sh
node server.mjs
```

The UI and API are served at `http://localhost:4173`. This is a prototype: metadata and JSON records are stored in `data.json`; uploaded CSV files are stored under `uploads/`. It is not a database. For cloud deployment, set `PORT` automatically through the platform, `DATA_DIR` to a persistent mounted directory, and `INGEST_API_KEY` to a long random secret.

The handoff contract follows [HANDOFF-SCHEMA.md](./HANDOFF-SCHEMA.md). A batch uses one shared metadata envelope; World Bank and UN Comtrade keep their own `records` fields.

## Read endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Check local API status |
| `GET` | `/api/sources` | List source catalog |
| `GET` | `/api/sources/:sourceId` | Read one source |
| `GET` | `/api/sources/:sourceId/failures` | Read failures since the last received batch |
| `GET` | `/api/sources/:sourceId/batches?limit=3` | Read recent batch metadata |
| `GET` | `/api/batches` | List batch metadata, newest first |
| `GET` | `/api/batches/:batchId` | Read one batch's metadata and errors |
| `GET` | `/api/batches/:batchId/records?offset=0&limit=100` | Read a page of inline JSON records |
| `GET` | `/api/batches/:batchId/file` | Download an uploaded CSV file |

List and detail responses omit inline `records` to avoid returning a large dataset accidentally. JSON records can be read separately in pages.

## Submit one JSON batch

Send the entire agreed JSON envelope to `POST /api/batches`. Add the `X-Ingest-Key` header when `INGEST_API_KEY` is configured:

```sh
curl -X POST http://localhost:4173/api/batches \
  -H 'Content-Type: application/json' \
  -H 'X-Ingest-Key: replace-with-your-secret' \
  -d @batch.json
```

The body in `batch.json` follows this structure:

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
  "record_count": 1,
  "errors": [
    {
      "error_id": "WB-INDICATOR-001",
      "stage": "collection",
      "message": "失业率指标本次未获取到数据。",
      "affected_count": null
    }
  ],
  "records": [
    {
      "record_type": "macro_indicator",
      "country_code": "CHN",
      "indicator_code": "NY.GDP.MKTP.CD",
      "indicator_name": "GDP (current US$)",
      "year": 2024,
      "value": 18300000000000,
      "unit": "current US$"
    }
  ]
}
```

The server checks the common envelope, source/domain registration, country-code shape, error fields, `record_count === records.length`, and the required fields for World Bank or Comtrade records. It generates `batch_id` and `received_at`; clients must not supply those. `collected_at` is the collector's timestamp, while `received_at` is when this platform accepted the handoff.

For a failed attempt with no data, send `status: "failed"`, `fetched_count: 0`, `record_count: 0`, `records: []`, and at least one error. For a partial result, use `status: "partial"` and include available records plus errors. A successful or partial batch updates the source's latest received time; a failed batch increments the source failure count.

## Submit CSV plus manifest

Upload both files as `multipart/form-data` to `POST /api/batches/csv`, also with `X-Ingest-Key`:

```sh
curl -X POST http://localhost:4173/api/batches/csv \
  -H 'X-Ingest-Key: replace-with-your-secret' \
  -F 'manifest=@comtrade-cn-vn-2024.manifest.json;type=application/json' \
  -F 'file=@comtrade-cn-vn-2024.csv;type=text/csv'
```

The manifest uses the common batch fields from `HANDOFF-SCHEMA.md` and adds `file_name` and `file_format: "csv"`. The server checks the row count against `record_count`, checks required headers for the two supported data groups, stores the original CSV in `uploads/`, and records the server-generated batch ID and receipt time. Uploaded files are not exposed through the static web route; download them through the batch file endpoint.

## Error fields

- `error_id`: an identifier for tracking one reported error.
- `stage`: `collection`, `parse`, `validation`, or `export`.
- `message`: a human-readable description.
- `affected_count`: number of affected records, or `null` when unknown.

## Notes and current limits

- Registered source IDs for the two current groups are `world-bank` and `comtrade`; domains are `经济` and `贸易与供应链` respectively.
- Countries use ISO alpha-3 codes such as `CHN` and `VNM`.
- JSON files are stored inline in the local `data.json`; CSV uploads are stored as files. This prototype has no database, authentication, multi-user access, cloud upload, or backup.
- CSV validation checks the header and record count, not every cell's value or business correctness.

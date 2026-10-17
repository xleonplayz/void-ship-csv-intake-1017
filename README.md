# Manifest Desk

A small receiving desk for supplier CSV files. Upload a UTF-8 CSV in an actual multipart request, validate stock codes, quantities and decimal prices, inspect integer-cent totals, then download a reviewed CSV. No database, login or external service is required; uploaded files are processed per request and never saved on the server.

Run with Node.js 22: `npm start`, then open port 3280. No third-party dependencies. `PORT` may override the listening port. `lily.toml` declares the HTTP port.

Input columns are `sku,name,quantity,unit_price`. SKUs must be unique uppercase codes; quantities are positive integers up to 99999; unit prices have two decimal places. Quoted commas, newlines, escaped quotes and an optional UTF-8 BOM are accepted. Limit: 5000 rows and 512 KiB including multipart framing. CSV exports use a BOM and CRLF and escape formula-like text. UI shows the first 50 lines while the export includes all lines.

The review threshold is a versioned business rule in `policy.js`. This repository contains synthetic public examples only. It is a Dev-Void compatibility case, not a persistent warehouse system.

Dev compatibility: the initial standard `for await (const chunk of req)` implementation works under Node 22 but is rejected by the deployed JS compiler. The request body reader therefore uses `data`, `end` and `error` listeners. Upload limits and validation are unchanged. This is an application workaround for a compiler limitation, not a compiler fix.

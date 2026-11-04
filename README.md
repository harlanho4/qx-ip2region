# Quantumult X ip2region GeoIP

A lightweight IPv4/IPv6 geolocation checker powered by the [ip2region](https://github.com/lionsoul2014/ip2region) XDB databases, Cloudflare Workers and private R2 object storage.

## Quantumult X

Use HTTPS for both URLs. The worker JSON endpoint has been verified to
work over HTTPS in Quantumult X; the original display script was the
compatibility issue. The v4.0 minimal script uses the same top-level `$done` pattern
as the working diagnostic script.

```ini
geo_location_checker = https://qx-ip2region.harlanho4.workers.dev/geo, https://qx-ip2region.harlanho4.workers.dev/qx-lite.js
```

### Troubleshooting

The diagnostic script is available for distinguishing query transport
from JavaScript rendering:

```ini
geo_location_checker = https://qx-ip2region.harlanho4.workers.dev/geo, https://qx-ip2region.harlanho4.workers.dev/qx-check.js
```

A successful diagnostic displays "自定义 GeoIP 脚本已生效" with
"QX CHECK · v3.0 · HTTP 200". The production `qx-lite.js`
script is a compact, top-level JavaScript renderer that always calls `$done`
and displays the country, locality, ISP, IP family and data provenance.
The legacy `qx-v2.js` and `qx-v22.js` routes remain available
for compatibility. Using the fresh `qx-lite.js` address avoids cached
copies of older script bodies.

## Refreshing Quantumult X

After updating your profile, use the versioned `/qx-lite.js` path shown above and apply/reload the active Quantumult X configuration. The former `/qx.js` path is preserved for compatibility but older scripts may remain cached locally by the client. The server sends `Cache-Control: no-store` for both endpoints. Actual presentation is limited to Quantumult X's native title/subtitle/IP/description fields.

## Live endpoints

- [GeoIP query](https://qx-ip2region.harlanho4.workers.dev/geo): returns ip-api-compatible fields for the **requester's exit IP**, including country, province, city, ISP and country code.
- [Quantumult X display script, v4.0](https://qx-ip2region.harlanho4.workers.dev/qx-lite.js) (versioned URL to bypass client script caches).
- [Health](https://qx-ip2region.harlanho4.workers.dev/health): active XDB version hashes and display script version.

## Architecture

- Cloudflare Worker name: `qx-ip2region`
- Private Cloudflare R2 bucket: `qx-ip2region-xdb`
- Scheduled automatic database synchronization: `0 3 * * *` UTC (11:00 Beijing time).
- Automated deployment fallback: every 10 minutes (`*/10 * * * *` UTC), Cron polls the GitHub main-branch commit SHA and starts a Cloudflare Workers Build through a private Deploy Hook only when it changes.
- Data source: [lionsoul2014/ip2region](https://github.com/lionsoul2014/ip2region), Apache-2.0.
- Worker queries the local R2 objects with HTTP-style byte ranges, caching only the 512-KiB vector index for each XDB version.
- Upstream updates compare GitHub blob hashes, download binaries pinned to the same commit, validate file sizes/XDB headers and sample lookups, and switch a single active R2 manifest only after both versions are ready.
- Previous XDB objects and historical manifests are retained for rollback.
- The API refuses arbitrary IP-query parameters to prevent misuse and uses the Cloudflare client IP header to identify the Quantumult X proxy's exit IP.

## Public repository security

This repository contains only source files and configuration identifiers. Keep
Cloudflare credentials, local `.env` files and `.dev.vars` files outside of Git.
The XDB databases remain in a private R2 bucket; public R2 access is disabled.
The `/geo` endpoint enforces a 60-request-per-minute limit per client egress
IP and Cloudflare location after deployment of the current Wrangler config.
See [SECURITY.md](SECURITY.md) for the threat model and disclosure process.

To enable Cloudflare Workers Builds, connect only this repository to the
existing `qx-ip2region` Worker, use `main` as the production branch,
set the build command to `npm run build` and deployment command to
`npx wrangler deploy`, and disable branch/PR previews until a separate
test-only R2 bucket is configured. GitHub actions or untrusted preview code
must never receive production Cloudflare credentials or production R2 bindings.

## Development and deployment

```bash
npm install
npm test
npx wrangler deploy
```

The Cloudflare Worker is configured in [wrangler.jsonc](wrangler.jsonc). It uses the existing private R2 bucket. Cloudflare Workers Builds is connected to the main branch and uses `npm run build` before `npx wrangler deploy`. The production Worker also polls the GitHub source every 10 minutes as a fallback when GitHub push webhooks are delayed or unavailable. The Cloudflare Deploy Hook UUID is stored only in a private R2 object, `internal/deploy-hook-uuid`, and never committed to GitHub. The fallback records the last accepted source SHA in `internal/deploy-last.json`. It retries hook requests on a subsequent check if triggering fails. The scheduled XDB update runs independently via Cloudflare Cron Triggers. GitHub Actions runs unit tests on commits and performs live API smoke checks; its scheduled workflow checks production weekly.

Cloudflare's R2 range API is used for data access. This cuts cold-start memory consumption at the cost of multiple R2 Class B operations per query. Actual endpoint behavior must be tested from Quantumult X to verify the proxy routes the request through the selected node.

## API output

```json
{
  "status": "success",
  "query": "1.2.3.4",
  "country": "Australia",
  "regionName": "Queensland",
  "city": "Brisbane",
  "isp": "",
  "org": "",
  "countryCode": "AU"
}
```

The `org` field is deliberately empty; ip2region's public dataset does not include a dedicated data-center organization attribute.

## Attribution

ip2region XDB databases © ip2region contributors, Apache-2.0 OR MIT. This repository uses the upstream data and documents the original project URL.

# Security policy

This repository contains public source code for a self-hosted Quantumult X GeoIP service. The Cloudflare account, R2 buckets, and build credentials remain private infrastructure.

## Security reporting

To report a vulnerability, use GitHub's private vulnerability reporting feature (if enabled) or contact the repository maintainer privately. Avoid publishing exploit details or sensitive data in GitHub Issues.

## Deployment safeguards

- Use a dedicated Cloudflare Worker and a private R2 bucket; never enable R2 public domains for XDB data.
- Store API tokens only as Cloudflare secrets or a managed build credential, never as source files or Actions logs.
- Restrict the Cloudflare GitHub App to this repository only and production deployments to the `main` branch.
- Disable untrusted pull-request preview builds that can access production bindings.
- Use the built-in Cloudflare rate limit for `/geo` (60 requests per minute per egress IP per Cloudflare location). Limits are approximate and do not provide a globally strict guarantee.
- Protect production `main` with PR reviews or required checks when available; enable GitHub secret scanning and push protection.
- Do not log raw client IP addresses. Avoid enabling raw request logs or persisting geolocation results without a defined retention policy.

## Data and privacy

`/geo` returns the requesting client's IP address and its inferred country/province/city/ISP. The service uses the Cloudflare-provided `CF-Connecting-IP` header, and the rate limiter temporarily keys counters by that address. Standard Cloudflare platform-level traffic processing still applies. IP geolocation is approximate.

## Visibility changes

Changing a repository to public exposes existing commits and GitHub Actions run logs. Before changing visibility, review historic commits and any workflow artifacts for accidentally committed credentials. If a real credential appears in history, rotate/revoke it before making the repository public; removing it from the latest commit alone is insufficient.

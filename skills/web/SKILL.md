---
name: web
description: Search the web and fetch a page as markdown with the Keenable CLI. Use when the task needs current facts, documentation, or the contents of a URL that are not in the workspace.
---

# Web search and fetch

The sandbox image includes `keenable` on `PATH`. These scripts print **YAML**. Run them from the workspace root. Do not pass `-p`. Do not run `keenable login`, `configure-mcp`, or `update`. Do not put API keys or fetched secrets into the app.

## Search

```bash
bash .baby/skills/web/scripts/search.sh "rust async patterns"
bash .baby/skills/web/scripts/search.sh "AI news" --site techcrunch.com --max-results 5
bash .baby/skills/web/scripts/search.sh "release notes" --published-after 30d
```

Optional flags: `--site`, `--mode realtime|pro`, `--max-results` (1–50, default 10), `--snippet-max-length` (180–10000), `--published-after`, `--published-before`, `--acquired-after`, `--acquired-before`, `--query-time`. Dates are `YYYY-MM-DD`, ISO 8601, or a relative delta (`30min`, `7d`, `6mo`, `1y`).

Quote the query. The command must be this script alone — no pipes, `&&`, or `$()`.

## Fetch

```bash
bash .baby/skills/web/scripts/fetch.sh https://example.com
bash .baby/skills/web/scripts/fetch.sh https://example.com --live
bash .baby/skills/web/scripts/fetch.sh https://example.com --prompt "List pricing tiers and monthly prices"
```

`--live` reads the page from the source instead of the index. `--prompt` (max 2000 characters) returns only that extraction. `--max-chars` raises the 50000-character cap.

Indexed URLs work without `--live`. If fetch says the URL is not indexed, retry once with `--live`.

## Errors

YAML `error:` is a failure. `429` means the rate limit — wait for `retry_after` or stop. Do not scrape the same URL with `curl`.

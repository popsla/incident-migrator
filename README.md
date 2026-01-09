# incident-io-retro-importer

A CLI tool for exporting incidents from one incident.io environment and importing them into another as retrospective incidents.

## Features

- **Export incidents** with pagination support and flexible filtering
- **Import as retrospective incidents** without triggering Slack notifications
- **Idempotent imports** with state tracking to prevent duplicates
- **Best-effort mapping** of entities between environments:
  - Severities (by name, fallback by rank)
  - Statuses (by name + category, fallback by category)
  - Incident types (by name)
  - Custom fields (by name, with option value mapping)
  - Timestamps (by name)
  - Users (by email, fallback by Slack user ID)
  - Incident roles (by name, with user assignment)
- **Preserves incident data**:
  - Name, summary, visibility
  - Severity, status, type
  - Custom field values
  - Timestamp values
  - Role assignments
  - Postmortem document URL
  - Follow-ups (exported; included in bundle)
  - Incident updates (exported; included in bundle)
- **Robust error handling** with automatic retries on rate limits and server errors
- **Concurrent imports** with configurable concurrency
- **Dry-run mode** for safe preview before import
- **Detailed reporting** with warnings for unmapped entities

## Installation

```bash
npm install
npm run build
```

## Prerequisites

- Node.js 20+
- API keys for both SOURCE and TARGET incident.io environments
  - Create API keys at: `https://app.incident.io/settings/api-keys`
  - Required scopes: read incidents, write incidents, read configuration

## Configuration

Set the following environment variables:

```bash
# Required for export
export SOURCE_API_KEY="your-source-api-key"

# Required for import
export TARGET_API_KEY="your-target-api-key"

```

## Usage

### 1. Validate Credentials

```bash
node dist/cli.js validate
```

This checks connectivity and credentials for both SOURCE and TARGET environments.

### 2. Export Incidents

Export all incidents:

```bash
node dist/cli.js export --out ./exports
```

Export with filters:

```bash
# Export incidents from the last 30 days
node dist/cli.js export \
  --out ./exports \
  --created-after 2024-01-01T00:00:00Z \
  --created-before 2024-01-31T23:59:59Z

# Export only closed incidents
node dist/cli.js export \
  --out ./exports \
  --status-category closed \
  --limit 100

# Enable debug logging
node dist/cli.js export --out ./exports --debug
```

**Output:**
- `exports/incidents.jsonl` - One incident bundle per line (JSONL format)
- `exports/manifest.json` - Export metadata (timestamp, filters, counts)

### 3. Import Incidents

#### Dry Run (Recommended First)

Preview the import without making changes:

```bash
node dist/cli.js import \
  --in ./exports \
  --dry-run
```

#### Production Import

Basic import:

```bash
node dist/cli.js import --in ./exports
```

Import with source context for better mapping:

```bash
# Requires SOURCE_API_KEY to be set
node dist/cli.js import \
  --in ./exports \
  --with-source-context
```

Import with options:

```bash
node dist/cli.js import \
  --in ./exports \
  --with-source-context \
  --concurrency 10 \
  --resume \
  --state-file ./custom-state.json \
  --report-file ./custom-report.json
```

**Output:**
- `state.json` - Mapping of source incident IDs to target incident IDs (for idempotency)
- `import-report.json` - Detailed results with warnings per incident

### 4. Resume After Interruption

If an import is interrupted, resume from the last successful state:

```bash
node dist/cli.js import \
  --in ./exports \
  --resume
```

This reads `state.json` and skips already-imported incidents.

## CLI Reference

### Export Command

```
node dist/cli.js export [options]

Options:
  --out <dir>                    Output directory for export files (required)
  --created-after <date>         Filter incidents created after this date (ISO 8601)
  --created-before <date>        Filter incidents created before this date (ISO 8601)
  --status-category <category>   Filter by status category:
                                 triage|declined|merged|canceled|live|learning|closed
  --limit <n>                    Maximum number of incidents to export
  --debug                        Enable debug logging
```

### Import Command

```
node dist/cli.js import [options]

Options:
  --in <path>                    Input directory or JSONL file (required)
  --dry-run                      Preview import without making changes
  --resume                       Resume from previous import using state.json
  --concurrency <n>              Number of concurrent imports (default: 5)
  --strict                       Fail if required mappings are missing (default: false)
  --state-file <path>            Path to state file (default: state.json)
  --report-file <path>           Path to report file (default: import-report.json)
  --with-source-context          Fetch source environment context for better mapping
                                 (requires SOURCE_API_KEY)
  --debug                        Enable debug logging
```

### Validate Command

```
node dist/cli.js validate [options]

Options:
  --source                       Validate SOURCE environment only
  --target                       Validate TARGET environment only
```

## How It Works

### Export Process

1. Connects to SOURCE environment using `SOURCE_API_KEY`
2. Fetches incidents with pagination (supports filters)
3. For each incident:
   - Fetches full incident details
   - Fetches follow-ups
   - Fetches incident updates
   - Bundles into a single JSON object
4. Writes bundles to JSONL file (one incident per line, streaming)
5. Writes manifest with export metadata

### Import Process

1. Connects to TARGET environment using `TARGET_API_KEY`
2. Optionally connects to SOURCE environment to fetch configuration for better mapping
3. Loads target environment configuration:
   - Severities, statuses, types
   - Custom fields (with options)
   - Timestamps, roles
   - Users (with pagination)
4. Reads incident bundles from JSONL file (streaming)
5. For each incident:
   - Maps all entities to target environment IDs
   - Creates incident with `mode: "retrospective"` (no Slack notification)
   - Sets `retrospective_incident_options.external_id` to source reference for tracking
   - Includes `postmortem_document_url` if present
   - Uses deterministic `idempotency_key` to prevent duplicates
   - Records source→target mapping in state file
6. Generates detailed report with warnings

### Mapping Strategy

The tool uses best-effort mapping with fallbacks:

| Entity | Primary Match | Fallback | Notes |
|--------|---------------|----------|-------|
| Severity | Name (case-insensitive) | Closest rank | Warns on fallback |
| Status | Name + category | Name only, then category only | Warns on partial match |
| Incident Type | Name (case-insensitive) | None | Warns if not found |
| Custom Field | Name (case-insensitive) | None | Maps values for select fields |
| Timestamp | Name (case-insensitive) | None | Requires source context |
| User | Email (case-insensitive) | Slack user ID | Warns on ID match |
| Role | Name (case-insensitive) | None | Maps assignees by user mapping |

**Important:** Use `--with-source-context` flag for accurate mapping of timestamps, custom fields, and roles.

## Limitations

1. **Postmortem Document Content:** The API does not provide an endpoint to export/import the full postmortem document body. Only the `postmortem_document_url` is preserved as a reference.

2. **Follow-ups:** Follow-ups are exported in the bundle but are not imported. They are available in the JSONL for reference. Future versions may support importing follow-ups if an appropriate creation endpoint is available.

3. **Incident Updates:** Incident updates (status changes, etc.) are exported but not re-created on import, as the target incident starts in a retrospective state.

4. **Attachments:** Not currently exported or imported. May be added in future versions if API support exists.

5. **Slack Channels:** Retrospective incidents do not create Slack channels. Slack channel references from source are included in `retrospective_incident_options` but are for reference only.

6. **External References:** If your source environment has integrations (Jira, PagerDuty, etc.), those external references are not automatically migrated.

## Safety & Idempotency

### Safety

- **Non-destructive:** Imports only create new incidents; existing incidents are never modified
- **No Slack spam:** Using `mode: "retrospective"` ensures no Slack announcements
- **Dry-run mode:** Always test with `--dry-run` first

### Idempotency

- Each import generates a deterministic `idempotency_key` based on source incident ID
- incident.io's API deduplicates requests with the same idempotency key
- State file (`state.json`) tracks source→target mappings
- Re-running import with `--resume` skips already-imported incidents
- Safe to re-run: duplicates will not be created

## Rate Limiting

The tool handles incident.io's rate limits automatically:

- Default limit: 1200 requests/minute
- Automatic retry with exponential backoff on 429 responses
- Respects `retry-after` header when provided
- Concurrent imports respect rate limits via controlled concurrency

If you hit rate limits frequently, reduce `--concurrency`.

## Troubleshooting

### Problem: "API key invalid" or 401 errors

**Solution:** Verify your API keys are correct and have the required scopes:
```bash
node dist/cli.js validate
```

### Problem: Many mapping warnings

**Solution:** Use `--with-source-context` to fetch source configuration for accurate mapping:
```bash
node dist/cli.js import --in ./exports --with-source-context
```

### Problem: Import creates incidents with missing fields

**Solution:** Check `import-report.json` for warnings. Unmapped entities are skipped with warnings. You may need to:
- Create missing severities/statuses/types in target environment
- Ensure users exist in target environment (invite them first)
- Create missing custom fields with matching names

### Problem: Rate limit errors (429)

**Solution:** The tool retries automatically, but if it persists:
- Reduce `--concurrency` (default is 5, try 2-3)
- Wait a few minutes and retry with `--resume`

### Problem: Import interrupted mid-process

**Solution:** Resume from last successful state:
```bash
node dist/cli.js import --in ./exports --resume
```

### Problem: Strict mode failures

If you use `--strict` and mapping fails:
```bash
node dist/cli.js import --in ./exports --strict
```

**Solution:** Check the error message for which mapping failed. Either:
- Remove `--strict` to allow best-effort mapping
- Create the missing entity in target environment and retry

## Development

### Run Tests

```bash
npm test
```

### Lint & Format

```bash
npm run lint
npm run format
```

### Build

```bash
npm run build
```

## Example Workflow

```bash
# 1. Set up environment
export SOURCE_API_KEY="sk_live_source_key"
export TARGET_API_KEY="sk_live_target_key"

# 2. Validate credentials
node dist/cli.js validate

# 3. Export from source (last 90 days, closed incidents only)
node dist/cli.js export \
  --out ./exports \
  --created-after 2024-01-01T00:00:00Z \
  --status-category closed

# 4. Preview import (dry run)
node dist/cli.js import \
  --in ./exports \
  --with-source-context \
  --dry-run

# 5. Review dry-run output, then import for real
node dist/cli.js import \
  --in ./exports \
  --with-source-context

# 6. Review results
cat import-report.json | jq '.summary'
cat import-report.json | jq '.results[] | select(.warnings | length > 0)'
```

## Architecture

```
src/
├── cli.ts                    # CLI entry point (commander)
├── api/
│   └── client.ts            # API client with retry/backoff
├── export/
│   └── exporter.ts          # Export logic
├── import/
│   └── importer.ts          # Import logic with concurrency
├── mapping/
│   ├── index.ts             # Build mapping context
│   └── mappers.ts           # Entity mapping functions
├── util/
│   ├── logging.ts           # Logger utility
│   └── fs.ts                # File system helpers (JSONL, JSON)
└── types.ts                 # TypeScript types
```

## Contributing

This is a production tool. When making changes:

1. Write tests for new mapping logic
2. Handle errors gracefully with retries
3. Add warnings to import report (don't fail silently)
4. Update README with new options or limitations

## License

MIT

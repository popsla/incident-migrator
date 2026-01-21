# incident.io Retrospective Importer

CLI tool for migrating incidents between incident.io environments using the retrospective incident API.

## TL;DR for Slack

```
Incident Migrator - Quick Summary

WHAT IT DOES:
- Exports incidents from SOURCE environment
- Imports them as retrospective incidents in TARGET environment
- Automatically creates new or updates existing incidents (by reference/external_id)

PREREQUISITES:
1. API keys for both environments with these scopes:
   - SOURCE: Read incidents
   - TARGET: Create incidents, Edit incidents
2. Contact incident.io to enable external_id feature flag (preserves INC-X numbers)
3. Matching configuration in target: severities, incident types, custom fields (by name)
4. Users invited to target environment (matched by email)

BEHAVIOR:
- New incidents: Created with matching INC-X number (Slack channel auto-created)
- Existing incidents: Updated in place (no new channel)
- Rate limited: 100ms between requests + auto-retry on 429
- Idempotent: Safe to re-run, won't create duplicates

USAGE:
  # Export
  SOURCE_API_KEY=inc_xxx node dist/cli.js export --out ./export

  # Import (dry-run first!)
  TARGET_API_KEY=inc_xxx node dist/cli.js import --in ./export --dry-run
  TARGET_API_KEY=inc_xxx node dist/cli.js import --in ./export

For MS Teams environments, add: --no-slack-channel
```

## Features

- Export incidents with follow-ups and incident updates
- Import as retrospective incidents
- Automatic upsert: creates new or updates existing
- Preserves incident numbers via external_id (requires feature flag)
- Maps entities by name between environments
- Rate limiting with automatic retry and backoff
- Concurrent imports with configurable concurrency
- Dry-run mode for safe preview

## Prerequisites

- Node.js 20+
- API keys for source and target incident.io environments
- For external_id preservation: contact incident.io to enable the feature flag
- For Jira attachment: Jira integration must be installed in target

## Installation

```bash
npm install
npm run build
```

## Configuration

```bash
export SOURCE_API_KEY="inc_xxx"  # required for export
export TARGET_API_KEY="inc_xxx"  # required for import
```

## Usage

### Export

```bash
node dist/cli.js export --out ./export

# with filters
node dist/cli.js export --out ./export \
  --created-after 2024-01-01T00:00:00Z \
  --status-category closed \
  --limit 100
```

### Import

```bash
# dry-run first (always recommended)
node dist/cli.js import --in ./export --dry-run

# actual import
node dist/cli.js import --in ./export
```

### Import Options

| Option | Description |
|--------|-------------|
| `--in <path>` | Input directory or JSONL file (required) |
| `--dry-run` | Preview without making changes |
| `--concurrency <n>` | Concurrent imports (default: 5) |
| `--limit <n>` | Max incidents to import |
| `--no-slack-channel` | For MS Teams environments |
| `--no-external-id` | Skip external_id (if feature flag not enabled) |
| `--strict` | Fail on mapping errors |
| `--debug` | Enable debug logging |

## What Gets Imported

| Data | Imported | Notes |
|------|----------|-------|
| Name, summary | Yes | |
| Severity | Yes | Mapped by name, fallback by rank |
| Incident type | Yes | Mapped by name |
| Custom fields | Yes | Mapped by name |
| Timestamps | Yes | Mapped by name |
| Role assignments | Yes | Except reporter (cannot be changed) |
| Postmortem URL | Yes | |
| Jira tickets | Yes | Via incident attachments API |
| External ID | Yes | Requires feature flag |
| Related incidents | Export only | No create API exists |

## Import Behavior

The importer uses **automatic upsert**:

1. **Check state.json** - Maps source incident ID to target incident ID
2. **Check by reference** - Looks for matching INC-X in target
3. **Check by external_id** - If create fails due to existing external_id, finds and updates instead
4. **Create if new** - Creates with same INC-X number, Slack creates a channel

This ensures:
- No duplicates are created
- Incident numbers are preserved
- Re-running is safe (idempotent)

## Limitations

### API Limitations (cannot be fixed)

| Limitation | Reason |
|------------|--------|
| Status locked to closed | Retrospective incidents cannot have active statuses |
| Follow-ups not imported | No create endpoint exists |
| Incident updates not imported | Read-only system records |
| Reporter role locked | Cannot be re-assigned |
| Related incidents not imported | No create endpoint exists |

### Configuration Requirements

For successful import, the target environment should have matching:

- Severities (by name)
- Incident types (by name)
- Custom fields (by name, with matching options)
- Users (by email) - invite before import

## Rate Limiting

- Minimum 100ms between requests
- Automatic retry with exponential backoff on 429
- Respects retry-after header
- Default concurrency of 5

For large imports (2000+ incidents), use `--concurrency 1`.

## Slack Channels

- **Slack environments**: New incidents get a channel auto-created
- **MS Teams environments**: Use `--no-slack-channel`
- **Updates**: Don't create new channels (uses existing)

## Troubleshooting

### 422: external_id requires feature flag
Contact incident.io to enable, or use `--no-external-id`.

### 422: visibility mismatch
The importer auto-adjusts visibility when incident type requires private.

### Many mapping warnings
Ensure target has matching configuration (severities, types, fields, users).

### Rate limit errors
Use `--concurrency 1` for large imports.

## License

MIT

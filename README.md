# incident.io Retrospective Importer

A CLI tool for exporting incidents from one incident.io environment and importing them into another as **retrospective incidents**.

This is useful when you want historical incidents in a new environment (for reporting, audits, demos, or migrations) without triggering Slack notifications or live workflows.

---

## Key behaviour

- **Imports incidents as retrospective** (no Slack channels for updates, no notifications)
- **Safe to re-run** - uses automatic upsert (creates new or updates existing)
- **Preserves incident numbers** via external_id (requires feature flag)
- **Dry-run support** to preview changes before importing

---

## Requirements

- Node.js 20+
- API keys for both environments (source and target)

Create API keys at:
https://app.incident.io/settings/api-keys

### Required API scopes

The tool uses **two API keys**: one for exporting from the source environment, and one for importing into the target environment.

#### Source environment API key (export)

The source key is **read-only**.

Enable the following scopes:

- **View data, like public incidents and organisation settings**
- **View all incident data, including private incidents**
- **View catalog types and entries**

#### Target environment API key (import)

The target key is used to **create and edit retrospective incidents**.

Enable the following scopes:

- **View data, like public incidents and organisation settings**
- **View all incident data, including private incidents**
- **Create incidents**
- **Edit incidents**

---

## Setup

Install dependencies and build:

```bash
npm install
npm run build
```

## Usage

### 1. Export incidents from the source environment

```bash
node dist/cli.js export --out ./export
```

### 2. Preview the import (recommended)

```bash
node dist/cli.js import --in ./export --dry-run
```

This shows what would be imported without making any changes.

### 3. Import incidents into the target environment

```bash
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

---

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

---

## Import Behavior

The importer uses **automatic upsert**:

1. **Check state.json** - Maps source incident ID to target incident ID
2. **Check by reference** - Looks for matching INC-X in target
3. **Check by external_id** - If create fails due to existing external_id, finds and updates instead
4. **Create if new** - Creates with same INC-X number

This ensures:
- No duplicates are created
- Incident numbers are preserved
- Re-running is safe (idempotent)

---

## Limitations

### API Limitations

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

---

## Rate Limiting

- Minimum 100ms between requests
- Automatic retry with exponential backoff on 429
- Respects retry-after header
- Default concurrency of 5

For large imports (2000+ incidents), use `--concurrency 1`.

---

## Slack Channels

- **Slack environments**: New incidents get a channel auto-created
- **MS Teams environments**: Use `--no-slack-channel`
- **Updates**: Don't create new channels (uses existing)

---

## Troubleshooting

### 422: external_id requires feature flag
Contact incident.io to enable, or use `--no-external-id`.

### 422: visibility mismatch
The importer auto-adjusts visibility when incident type requires private.

### Many mapping warnings
Ensure target has matching configuration (severities, types, fields, users).

### Rate limit errors
Use `--concurrency 1` for large imports.

---

## License

MIT

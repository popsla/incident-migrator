# Architecture

## Overview

This tool exports incidents from a SOURCE incident.io environment and imports them into a TARGET environment as retrospective incidents (without Slack notifications).

## Core Components

### 1. API Client (`src/api/client.ts`)

- **IncidentIoApiClient**: HTTP client with authentication, retry logic, and rate limiting
- **Features**:
  - Automatic retry on 429 (rate limit) and 5xx errors with exponential backoff
  - Respects `retry-after` header
  - Configurable max retries and retry delays
  - Type-safe API methods for all endpoints
- **Key Methods**:
  - `listIncidents()`: Paginated incident list
  - `createIncident()`: Create retrospective incidents
  - `listSeverities()`, `listIncidentStatuses()`, etc.: Configuration endpoints
  - `listUsers()`: User directory (paginated)
- **Pagination Helper**: `paginateAll()` - async generator for automatic pagination

### 2. Export (`src/export/exporter.ts`)

- **Exporter class**: Orchestrates incident export
- **Process**:
  1. Fetch incidents with pagination
  2. Apply client-side filters (date range)
  3. For each incident:
     - Fetch follow-ups
     - Fetch incident updates
     - Bundle into single object
  4. Stream to JSONL file (one incident per line)
  5. Generate manifest with metadata
- **Output**:
  - `incidents.jsonl`: Incident bundles
  - `manifest.json`: Export metadata

### 3. Import (`src/import/importer.ts`)

- **Importer class**: Orchestrates incident import
- **Process**:
  1. Load target environment configuration
  2. Optionally load source environment configuration (for better mapping)
  3. Read incident bundles from JSONL (streaming)
  4. For each incident:
     - Map all entities to target IDs
     - Create retrospective incident
     - Track in state file
  5. Generate detailed report
- **Features**:
  - Concurrent imports with configurable worker count
  - Resume from previous state
  - Dry-run mode
  - Strict mode (fail on mapping errors)
- **Output**:
  - `state.json`: source_id → target_id mapping
  - `import-report.json`: Detailed results with warnings

### 4. Mapping (`src/mapping/`)

- **index.ts**: `buildMappingContext()` - fetches all configuration from environment
- **mappers.ts**: Entity mapping functions with fallback strategies
- **MappingContext**: In-memory maps of all configuration entities

#### Mapping Strategies

| Entity | Primary | Fallback 1 | Fallback 2 |
|--------|---------|------------|------------|
| Severity | Name (case-insensitive) | Closest rank | - |
| Status | Name + category | Name only | Category only |
| Type | Name (case-insensitive) | - | - |
| Timestamp | Name (requires source context) | - | - |
| User | Email (case-insensitive) | Slack user ID | - |
| Role | Name (case-insensitive) | - | - |
| Custom Field | Name + option value | - | - |

All mappers return `MappingResult<T>` with:
- `value?: T` - Mapped ID (if successful)
- `warnings: string[]` - Any mapping issues

### 5. CLI (`src/cli.ts`)

- **Commander.js** based CLI
- **Commands**:
  - `export`: Export from SOURCE
  - `import`: Import to TARGET
  - `validate`: Test credentials
- **Configuration**: Environment variables
  - `SOURCE_API_KEY`, `TARGET_API_KEY`
  - Optional: `SOURCE_BASE_URL`, `TARGET_BASE_URL`

### 6. Utilities (`src/util/`)

- **logging.ts**: Simple logger with debug mode
- **fs.ts**: File system helpers
  - JSONL streaming (read/write)
  - JSON helpers
  - State and report persistence

## Data Flow

### Export Flow

```
SOURCE API
    ↓
List Incidents (paginated)
    ↓
For each incident:
    ↓
Get incident details
Get follow-ups
Get incident updates
    ↓
Bundle → JSONL
    ↓
incidents.jsonl + manifest.json
```

### Import Flow

```
incidents.jsonl
    ↓
Read bundles (streaming)
    ↓
Build TARGET mapping context
(Optionally: Build SOURCE context)
    ↓
For each bundle:
    ↓
Map entities (severity, status, etc.)
    ↓
Create retrospective incident
    ↓
Update state.json
    ↓
Generate import-report.json
```

## Key Design Decisions

### 1. Streaming JSONL Format

**Why**: Memory-efficient for large datasets (thousands of incidents)

- Incidents written line-by-line during export
- Incidents read line-by-line during import
- No need to load entire dataset into memory

### 2. Best-Effort Mapping

**Why**: Different environments have different configurations

- Mapping failures don't fail the entire import
- Warnings recorded for each unmapped entity
- User can review warnings and fix in target environment

### 3. Idempotency via State File

**Why**: Safe to re-run, resume after interruption

- `idempotency_key` prevents API duplicates
- `state.json` prevents client-side duplicates
- `--resume` flag skips already-imported incidents

### 4. Retrospective Mode

**Why**: No Slack spam, clean historical data

- `mode: "retrospective"` on create
- No Slack channel creation
- No Slack notifications
- Preserves `external_id` for reference

### 5. Concurrent Imports with Rate Limiting

**Why**: Fast imports while respecting API limits

- Configurable concurrency (default: 5)
- Automatic retry on 429
- Exponential backoff
- Respects `retry-after` header

### 6. TypeScript & Type Safety

**Why**: Prevent runtime errors, better DX

- Strict TypeScript mode
- Typed API responses
- Typed configuration
- Compile-time error checking

## Testing Strategy

- **Unit tests**: Mapping logic (`tests/mapping.test.ts`)
- **Integration tests**: (Future) End-to-end export/import with test fixtures
- **Manual testing**: Against real incident.io environments

## Future Enhancements

1. **Follow-up Import**: If API endpoint becomes available
2. **Incident Updates Import**: Replay status changes if needed
3. **Attachment Support**: If API supports attachment export/import
4. **Custom Field Creation**: Auto-create missing fields with `--create-missing-config`
5. **Incremental Export**: Only export new incidents since last run
6. **Conflict Resolution**: Handle incidents that exist in both environments
7. **Bulk Operations**: Batch API calls where supported

## Error Handling

- **Network errors**: Retry with exponential backoff
- **Rate limits**: Automatic retry with `retry-after`
- **API errors**: Log and continue (best-effort)
- **Mapping errors**: Warn and continue (unless `--strict`)
- **File I/O errors**: Fail fast with clear message

## Performance Considerations

- **Streaming**: JSONL avoids loading everything into memory
- **Concurrency**: Parallel imports (default: 5 workers)
- **Pagination**: Efficient API usage
- **Caching**: Mapping context built once per run
- **Rate limiting**: Automatic throttling

## Security Considerations

- **API Keys**: From environment variables (never committed)
- **HTTPS**: All API calls use HTTPS
- **No data transformation**: Data copied as-is (no injection risk)
- **Read-only exports**: Export never modifies source
- **Non-destructive imports**: Import only creates, never updates/deletes

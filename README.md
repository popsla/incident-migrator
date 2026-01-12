# incident-io-retro-importer

A CLI tool for exporting incidents from one incident.io environment and importing them into another as **retrospective incidents**.

This is useful when you want historical incidents in a new environment (for reporting, audits, demos, or migrations) without triggering Slack notifications or live workflows.

---

## Key behaviour

- **Imports incidents as retrospective** (no Slack channels, no notifications)
- **Safe to re-run** - already imported incidents are skipped
- **Non-destructive** - existing incidents are never modified
- **Dry-run support** to preview changes before importing

---

## Requirements

- Node.js 20+
- API keys for both environments (source and target)

Create API keys at:
`https://app.incident.io/settings/api-keys`

### Required API scopes

The tool uses **two API keys**: one for exporting from the source environment, and one for importing into the target environment.

#### Source environment API key (export)

The source key is **read-only**.

Enable the following scopes:

- **View data, like public incidents and organisation settings**
- **View all incident data, including private incidents**
- **View catalog types and entries**

#### Target environment API key (import)

The target key is used to **create retrospective incidents**.

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

## Optional: pre-commit hooks

This repo includes a `.pre-commit-config.yaml` to run basic checks (formatting, lint, TypeScript typecheck) before commits.

Enable it locally:

```bash
pre-commit install
```

## Usage

### 1. Validate credentials

```bash
node dist/cli.js validate
```

### 2. Export incidents from the source environment

```bash
node dist/cli.js export --out ./exports
```

### 3. Preview the import (recommended)

```bash
node dist/cli.js import --in ./exports --dry-run
```

This shows what would be imported without making any changes.

### 4. Import incidents into the target environment

```bash
node dist/cli.js import --in ./exports
```

Incidents are created as **retrospective**, so:

- no Slack channels are created
- no notifications are sent

### 5. Resume if interrupted

If the import stops partway through, you can safely resume:

```bash
node dist/cli.js import --in ./exports --resume
```

Already-imported incidents will be skipped.

## What gets imported

- Incident name, summary, and visibility
- Severity, status, and incident type
- Custom field values and timestamps
- Role assignments
- Postmortem document URL

Some data (such as Slack channels or external integrations) is included for reference only and not recreated.

## Help & options

Run the CLI with `--help` to see all available options:

```bash
node dist/cli.js --help
```

## License

MIT

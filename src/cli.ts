#!/usr/bin/env node

import { Command } from 'commander';
import { IncidentIoApiClient } from './api/client.js';
import { Exporter } from './export/exporter.js';
import { Importer } from './import/importer.js';
import { buildMappingContext } from './mapping/index.js';
import { generateCorrespondenceMatrix } from './correspondence/generateCorrespondenceMatrix.js';
import { patchCustomFieldIds } from './patch/patchCustomFieldIds.js';
import { logger } from './util/logging.js';
import type { Config } from './types.js';

const program = new Command();

program
  .name('incident-io-retro-importer')
  .description('Export and import incidents between incident.io environments')
  .version('1.0.0');

// Helper to get config from environment
function getConfig(isSource: boolean): Config {
  const apiKey = isSource ? process.env.SOURCE_API_KEY : process.env.TARGET_API_KEY;
  const baseUrl = isSource
    ? process.env.SOURCE_BASE_URL || 'https://api.incident.io'
    : process.env.TARGET_BASE_URL || 'https://api.incident.io';

  if (!apiKey) {
    throw new Error(`${isSource ? 'SOURCE' : 'TARGET'}_API_KEY environment variable is required`);
  }

  return {
    sourceApiKey: apiKey,
    targetApiKey: apiKey,
    sourceBaseUrl: baseUrl,
    targetBaseUrl: baseUrl,
  };
}

// Export command
program
  .command('export')
  .description('Export incidents from SOURCE environment')
  .requiredOption('--out <dir>', 'Output directory for export files')
  .option('--created-after <date>', 'Filter incidents created after this date (ISO 8601)')
  .option('--created-before <date>', 'Filter incidents created before this date (ISO 8601)')
  .option(
    '--status-category <category>',
    'Filter by status category (triage|declined|merged|canceled|live|learning|closed)'
  )
  .option('--limit <n>', 'Maximum number of incidents to export', parseInt)
  .option('--debug', 'Enable debug logging')
  .action(async (options) => {
    try {
      if (options.debug) {
        logger.setDebug(true);
      }

      const config = getConfig(true);
      const client = new IncidentIoApiClient({
        apiKey: config.sourceApiKey,
        baseUrl: config.sourceBaseUrl,
      });

      const exporter = new Exporter(client);
      await exporter.export({
        outputDir: options.out,
        createdAfter: options.createdAfter,
        createdBefore: options.createdBefore,
        statusCategory: options.statusCategory,
        limit: options.limit,
      });
    } catch (error) {
      logger.error('Export failed:', error);
      process.exit(1);
    }
  });

// Import command
program
  .command('import')
  .description('Import incidents into TARGET environment as retrospective incidents')
  .requiredOption('--in <path>', 'Input directory or file (JSONL) with exported incidents')
  .option('--dry-run', 'Preview import without making changes')
  .option('--resume', 'Resume from previous import using state.json')
  .option('--concurrency <n>', 'Number of concurrent imports', parseInt, 5)
  .option('--strict', 'Fail if required mappings are missing')
  .option('--state-file <path>', 'Path to state file', 'state.json')
  .option('--report-file <path>', 'Path to report file', 'import-report.json')
  .option('--debug', 'Enable debug logging')
  .option(
    '--with-source-context',
    'Build source environment context for better mapping (requires SOURCE_API_KEY)'
  )
  .action(async (options) => {
    try {
      if (options.debug) {
        logger.setDebug(true);
      }

      const config = getConfig(false);
      const client = new IncidentIoApiClient({
        apiKey: config.targetApiKey,
        baseUrl: config.targetBaseUrl,
      });

      // Optionally build source context for better mapping
      let sourceContext;
      if (options.withSourceContext) {
        logger.info('Building source environment context...');
        const sourceConfig = getConfig(true);
        const sourceClient = new IncidentIoApiClient({
          apiKey: sourceConfig.sourceApiKey,
          baseUrl: sourceConfig.sourceBaseUrl,
        });
        sourceContext = await buildMappingContext(sourceClient);
      }

      const importer = new Importer(client);
      await importer.import(
        {
          inputPath: options.in,
          dryRun: options.dryRun,
          resume: options.resume,
          concurrency: options.concurrency,
          strict: options.strict,
          stateFile: options.stateFile,
          reportFile: options.reportFile,
        },
        sourceContext
      );
    } catch (error) {
      logger.error('Import failed:', error);
      process.exit(1);
    }
  });

// Validate command
program
  .command('validate')
  .description('Validate connection and credentials for SOURCE and TARGET environments')
  .option('--source', 'Validate SOURCE environment only')
  .option('--target', 'Validate TARGET environment only')
  .action(async (options) => {
    try {
      const validateEnv = async (isSource: boolean) => {
        const label = isSource ? 'SOURCE' : 'TARGET';
        logger.info(`Validating ${label} environment...`);

        const config = getConfig(isSource);
        const client = new IncidentIoApiClient({
          apiKey: isSource ? config.sourceApiKey : config.targetApiKey,
          baseUrl: isSource ? config.sourceBaseUrl : config.targetBaseUrl,
        });

        const { severities } = await client.listSeverities();
        logger.success(`${label} environment: OK (found ${severities.length} severities)`);
      };

      if (!options.target) {
        await validateEnv(true);
      }
      if (!options.source) {
        await validateEnv(false);
      }
    } catch (error) {
      logger.error('Validation failed:', error);
      process.exit(1);
    }
  });

// Generate correspondence matrix for custom fields
program
  .command('generate-correspondence-matrix')
  .description('Generate a deterministic mapping CSV for custom fields between SOURCE and TARGET')
  .option('--out <path>', 'Output CSV file path', 'custom-fields-correspondence.csv')
  .option('--page-size <n>', 'API page size for listing custom fields', parseInt, 100)
  .option('--debug', 'Enable debug logging')
  .action(async (options) => {
    try {
      if (options.debug) {
        logger.setDebug(true);
      }

      // Requires both environments
      const sourceConfig = getConfig(true);
      const targetConfig = getConfig(false);

      const sourceClient = new IncidentIoApiClient({
        apiKey: sourceConfig.sourceApiKey,
        baseUrl: sourceConfig.sourceBaseUrl,
      });
      const targetClient = new IncidentIoApiClient({
        apiKey: targetConfig.targetApiKey,
        baseUrl: targetConfig.targetBaseUrl,
      });

      await generateCorrespondenceMatrix(sourceClient, targetClient, {
        outputFile: options.out,
        pageSize: options.pageSize,
      });
    } catch (error) {
      logger.error('generate-correspondence-matrix failed:', error);
      process.exit(1);
    }
  });

// Patch exported incidents custom field IDs using a correspondence CSV
program
  .command('patch')
  .description(
    'Patch exported incidents JSONL by replacing source custom field IDs with target IDs from a CSV mapping'
  )
  .requiredOption('--incidents <path>', 'Path to incidents.jsonl to patch')
  .requiredOption('--custom-fields <path>', 'Path to custom-fields.csv mapping file')
  .option(
    '--remove-custom-fields <path>',
    'Optional file containing list of custom fields to remove from incident payload'
  )
  .option('--out <path>', 'Output patched incidents JSONL (default: <incidents>.patched.jsonl)')
  .option('--in-place', 'Patch the incidents file in-place (atomic rewrite)')
  .option('--debug', 'Enable debug logging')
  .action(async (options) => {
    try {
      if (options.debug) {
        logger.setDebug(true);
      }

      await patchCustomFieldIds({
        incidentsFile: options.incidents,
        mappingCsvFile: options.customFields,
        outputFile: options.out,
        inPlace: options.inPlace,
        removeCustomFieldsFile: options.removeCustomFields,
      });
    } catch (error) {
      logger.error('patch failed:', error);
      process.exit(1);
    }
  });

program.parse();

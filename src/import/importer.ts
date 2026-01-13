import { join } from 'path';
import { IncidentIoApiClient } from '../api/client.js';
import { logger } from '../util/logging.js';
import {
  readJsonl,
  readState,
  writeState,
  writeReport,
  writeJson,
  fileExists,
  isDirectory,
} from '../util/fs.js';
import { normalizeIncident } from '../util/normalize.js';
import { buildMappingContext } from '../mapping/index.js';
import {
  mapSeverity,
  mapStatus,
  mapIncidentType,
  mapTimestampsWithContext,
  mapRoleAssignments,
  mapCustomFieldValues,
} from '../mapping/mappers.js';
import type {
  IncidentBundle,
  ImportState,
  ImportResult,
  ImportReport,
  CreateIncidentRequest,
  MappingContext,
  RetrospectiveIncidentOptions,
} from '../types.js';

export interface ImportOptions {
  inputPath: string;
  dryRun?: boolean;
  resume?: boolean;
  concurrency?: number;
  strict?: boolean;
  stateFile?: string;
  reportFile?: string;
}

export class Importer {
  private client: IncidentIoApiClient;
  private sourceContext?: MappingContext;

  constructor(client: IncidentIoApiClient) {
    this.client = client;
  }

  async import(options: ImportOptions, sourceContext?: MappingContext): Promise<void> {
    const {
      inputPath,
      dryRun = false,
      resume = false,
      concurrency = 5,
      strict = false,
      stateFile = 'state.json',
      reportFile = 'import-report.json',
    } = options;

    this.sourceContext = sourceContext;

    logger.info('Starting import...');
    if (dryRun) {
      logger.info('[DRY RUN MODE] No changes will be made');
    }

    // Load or initialize state
    // Always load existing state to prevent duplicates, regardless of resume flag
    let state: ImportState = { mapping: {}, lastImportedAt: new Date().toISOString() };
    if (await fileExists(stateFile)) {
      const existingState = await readState(stateFile);
      if (existingState) {
        state = existingState;
        const importedCount = Object.keys(state.mapping).length;
        if (importedCount > 0) {
          logger.info(
            `Found ${importedCount} previously imported incident(s), will skip duplicates`
          );
        }
        if (resume) {
          logger.info(`Resuming from previous import`);
        }
      }
    }

    // Build target mapping context
    logger.info('Building target environment mapping context...');
    const targetContext = await buildMappingContext(this.client);

    // Read incidents
    const bundles: IncidentBundle[] = [];
    let inputFile = inputPath;

    // If input is a directory, look for incidents.jsonl inside it
    if (await isDirectory(inputPath)) {
      inputFile = join(inputPath, 'incidents.jsonl');
    }

    logger.info(`Reading incidents from ${inputFile}...`);
    for await (const bundle of readJsonl<IncidentBundle>(inputFile)) {
      // Normalize incident data from API response format
      bundle.incident = normalizeIncident(bundle.incident);
      bundles.push(bundle);
    }
    logger.info(`Found ${bundles.length} incidents to import`);

    // Import with concurrency control
    const results: ImportResult[] = [];
    const queue = [...bundles];
    const workers: Promise<void>[] = [];

    for (let i = 0; i < concurrency; i++) {
      workers.push(
        (async () => {
          while (queue.length > 0) {
            const bundle = queue.shift();
            if (!bundle) break;

            const result = await this.importIncident(bundle, targetContext, state, {
              dryRun,
              strict,
            });
            results.push(result);

            if (result.status === 'created' && result.targetIncidentId) {
              state.mapping[bundle.incident.id] = result.targetIncidentId;
            }

            // Progress update
            if (results.length % 10 === 0) {
              logger.info(`Processed ${results.length}/${bundles.length} incidents...`);
            }
          }
        })()
      );
    }

    await Promise.all(workers);

    // Update state
    state.lastImportedAt = new Date().toISOString();
    if (!dryRun) {
      await writeState(stateFile, state);
    }

    // Generate report
    const summary = {
      total: results.length,
      created: results.filter((r) => r.status === 'created').length,
      skipped: results.filter((r) => r.status === 'skipped').length,
      failed: results.filter((r) => r.status === 'failed').length,
    };

    const report: ImportReport = {
      importedAt: new Date().toISOString(),
      summary,
      results,
    };

    if (!dryRun) {
      await writeReport(reportFile, report);
    }

    // Print summary
    logger.success('Import complete!');
    logger.info(`Total: ${summary.total}`);
    logger.info(`  Created: ${summary.created}`);
    logger.info(`  Skipped: ${summary.skipped}`);
    logger.info(`  Failed: ${summary.failed}`);

    const allWarnings = results.flatMap((r) => r.warnings);
    if (allWarnings.length > 0) {
      logger.warn(`Total warnings: ${allWarnings.length}`);
      // Show first few unique warnings
      const uniqueWarnings = [...new Set(allWarnings)].slice(0, 5);
      uniqueWarnings.forEach((w) => logger.warn(`  - ${w}`));
      if (allWarnings.length > 5) {
        logger.warn(`  ... and ${allWarnings.length - 5} more (see ${reportFile})`);
      }
      // Save allWarnings and some stats to a warnings file
      const warningsFile = reportFile.replace(/(\.\w+)?$/, '.warnings.json');
      const warningsStatsRaw: Record<string, number> = {};
      for (const warning of allWarnings) {
        warningsStatsRaw[warning] = (warningsStatsRaw[warning] || 0) + 1;
      }

      // Sort warnings by count DESC (stable) for easier triage
      const warningsSorted = Object.entries(warningsStatsRaw).sort(
        ([aKey, aCount], [bKey, bCount]) => bCount - aCount || aKey.localeCompare(bKey)
      );
      const warningsStats: Record<string, number> = Object.fromEntries(warningsSorted);

      // Organize warnings by kind for easier triage
      type WarningKind = 'Option' | 'User' | 'CustomField' | 'AlreadyImported' | 'Other';
      const kindForWarning = (warning: string): WarningKind => {
        if (warning === 'Already imported') return 'AlreadyImported';
        if (warning.startsWith('Option "')) return 'Option';
        if (warning.startsWith('User ')) return 'User';
        if (warning.startsWith('Custom field "')) return 'CustomField';
        return 'Other';
      };

      const warningsByKindRaw: Partial<Record<WarningKind, Record<string, number>>> = {};
      const kindTotalsRaw: Partial<Record<WarningKind, number>> = {};

      for (const [warning, count] of warningsSorted) {
        const kind = kindForWarning(warning);
        kindTotalsRaw[kind] = (kindTotalsRaw[kind] || 0) + count;
        const bucket = warningsByKindRaw[kind] || (warningsByKindRaw[kind] = {});
        bucket[warning] = count;
      }

      const kindTotalsEntries = Object.entries(kindTotalsRaw) as Array<[WarningKind, number]>;
      kindTotalsEntries.sort(
        ([aKind, aTotal], [bKind, bTotal]) => bTotal - aTotal || aKind.localeCompare(bKind)
      );
      const kindTotals = Object.fromEntries(kindTotalsEntries) as Record<WarningKind, number>;

      const warningsByKindEntries = Object.entries(warningsByKindRaw) as Array<
        [WarningKind, Record<string, number>]
      >;
      warningsByKindEntries.sort(
        ([aKind], [bKind]) => kindTotals[bKind] - kindTotals[aKind] || aKind.localeCompare(bKind)
      );
      const warningsByKind = Object.fromEntries(
        warningsByKindEntries.map(([kind, bucket]) => {
          const sorted = Object.entries(bucket).sort(
            ([aMsg, aCount], [bMsg, bCount]) => bCount - aCount || aMsg.localeCompare(bMsg)
          );
          return [kind, Object.fromEntries(sorted)];
        })
      ) as Record<WarningKind, Record<string, number>>;

      // Group option-missing warnings by field name: Option "<x>" in field "<FIELD>" not found in target
      const optionMissingRe = /^Option "(.+)" in field "(.+)" not found in target$/;
      const optionIssuesByField: Record<
        string,
        {
          total: number;
          unique: number;
          optionsStats: Record<string, number>;
          topOptions: Array<{ option: string; count: number }>;
        }
      > = {};

      for (const [warning, count] of warningsSorted) {
        const m = warning.match(optionMissingRe);
        if (!m) continue;
        const option = m[1];
        const field = m[2];

        const bucket =
          optionIssuesByField[field] ||
          (optionIssuesByField[field] = {
            total: 0,
            unique: 0,
            optionsStats: {},
            topOptions: [],
          });

        bucket.total += count;
        bucket.optionsStats[option] = (bucket.optionsStats[option] || 0) + count;
      }

      // Finalize option issue buckets with sorted option stats (DESC) + topOptions
      for (const [field, bucket] of Object.entries(optionIssuesByField)) {
        const sortedOptions = Object.entries(bucket.optionsStats).sort(
          ([aOpt, aCount], [bOpt, bCount]) => bCount - aCount || aOpt.localeCompare(bOpt)
        );
        bucket.optionsStats = Object.fromEntries(sortedOptions);
        bucket.unique = sortedOptions.length;
        bucket.topOptions = sortedOptions.slice(0, 20).map(([option, c]) => ({ option, count: c }));
        optionIssuesByField[field] = bucket;
      }

      const optionIssuesByFieldSorted = Object.fromEntries(
        Object.entries(optionIssuesByField).sort(
          ([aField, aBucket], [bField, bBucket]) => bBucket.total - aBucket.total || aField.localeCompare(bField)
        )
      );

      const warningsOutput = {
        totalWarnings: allWarnings.length,
        uniqueWarnings: Object.keys(warningsStatsRaw).length,
        warningsStats,
        kindTotals,
        warningsByKind,
        optionIssuesByField: optionIssuesByFieldSorted,
        samples: [...new Set(allWarnings)].slice(0, 20),
        allWarnings, // for reference, in case detailed review is desired
      };
      await writeJson(warningsFile, warningsOutput);
      logger.info(`Warnings written to: ${warningsFile}`);
    }

    if (!dryRun) {
      logger.info(`Report: ${reportFile}`);
      logger.info(`State: ${stateFile}`);
    }
  }

  private async importIncident(
    bundle: IncidentBundle,
    targetContext: MappingContext,
    state: ImportState,
    options: { dryRun: boolean; strict: boolean }
  ): Promise<ImportResult> {
    const { incident } = bundle;
    const result: ImportResult = {
      sourceIncidentId: incident.id,
      status: 'failed',
      warnings: [],
    };

    try {
      // Check if already imported
      if (state.mapping[incident.id]) {
        result.status = 'skipped';
        result.targetIncidentId = state.mapping[incident.id];
        result.warnings.push('Already imported');
        logger.debug(`Skipping ${incident.reference} (already imported)`);
        return result;
      }

      logger.debug(`Importing ${incident.reference}: ${incident.name}`);

      // Map severity
      const severityResult = mapSeverity(incident.severity, targetContext.severities);
      result.warnings.push(...severityResult.warnings);
      if (options.strict && !severityResult.value) {
        throw new Error(`Severity mapping failed in strict mode`);
      }

      // Map status - if null in source, default to "Closed" for retrospective imports
      let statusResult = mapStatus(incident.status, targetContext.statuses);
      if (!statusResult.value && !incident.status) {
        // No status in source - find "Closed" status in target for retrospective incidents
        for (const [id, status] of targetContext.statuses) {
          if (status.category === 'closed' || status.name.toLowerCase().includes('closed')) {
            statusResult = {
              value: id,
              warnings: ['Status was null in source, defaulted to Closed'],
            };
            break;
          }
        }
      }
      result.warnings.push(...statusResult.warnings);
      if (options.strict && !statusResult.value) {
        throw new Error(`Status mapping failed in strict mode`);
      }

      // Map incident type
      const typeResult = mapIncidentType(incident.incident_type, targetContext.types);
      result.warnings.push(...typeResult.warnings);

      // Map timestamps - works with names from export data or source context
      const timestampResult = mapTimestampsWithContext(
        incident.incident_timestamp_values,
        this.sourceContext?.timestamps || new Map(),
        targetContext.timestamps
      );
      result.warnings.push(...timestampResult.warnings);

      // Map role assignments - works with names from export data or source context
      const roleResult = mapRoleAssignments(
        incident.incident_role_assignments,
        this.sourceContext?.roles || new Map(),
        targetContext.roles,
        targetContext.users
      );
      result.warnings.push(...roleResult.warnings);

      // Map custom fields - works with names from export data or source context
      const customFieldResult = mapCustomFieldValues(
        incident.custom_field_values,
        this.sourceContext?.customFields || new Map(),
        targetContext.customFields,
        targetContext.catalogEntriesByType
      );
      result.warnings.push(...customFieldResult.warnings);

      // Extract numeric external_id from reference (e.g., "INC-48" -> 48)
      const extractNumericId = (reference: string): number | undefined => {
        const match = reference.match(/\d+$/);
        return match ? parseInt(match[0], 10) : undefined;
      };

      // Build retrospective options
      const retrospectiveOptions: RetrospectiveIncidentOptions = {};

      // TODO: For production customer migration with preserved incident numbers:
      // Set USE_EXTERNAL_ID = true and ensure target incident counter is offset appropriately first.
      // The target counter must be HIGHER than the highest source incident number.
      const USE_EXTERNAL_ID = true;

      if (USE_EXTERNAL_ID) {
        const externalId = extractNumericId(incident.reference);
        if (externalId !== undefined) {
          retrospectiveOptions.external_id = externalId;
        }
      }

      if (incident.postmortem_document_url) {
        retrospectiveOptions.postmortem_document_url = incident.postmortem_document_url;
      }

      // Build create request
      const createRequest: CreateIncidentRequest = {
        mode: 'retrospective',
        name: incident.name,
        summary: incident.summary,
        visibility: incident.visibility,
        idempotency_key: `retro-import:${incident.id}`,
        retrospective_incident_options: retrospectiveOptions,
      };

      if (severityResult.value) {
        createRequest.severity_id = severityResult.value;
      }
      if (statusResult.value) {
        createRequest.incident_status_id = statusResult.value;
      }
      if (typeResult.value) {
        createRequest.incident_type_id = typeResult.value;
      }
      if (timestampResult.value && timestampResult.value.length > 0) {
        createRequest.incident_timestamp_values = timestampResult.value;
        logger.debug(
          `Mapped ${timestampResult.value.length} timestamps for ${incident.reference}:`
        );
        timestampResult.value.forEach((ts) => {
          logger.debug(`  - ${ts.incident_timestamp_id}: ${ts.value}`);
        });
      } else {
        logger.debug(
          `No timestamps mapped for ${incident.reference} (source had ${incident.incident_timestamp_values?.length || 0})`
        );
      }
      if (roleResult.value && roleResult.value.length > 0) {
        createRequest.incident_role_assignments = roleResult.value;
        logger.debug(`Mapped ${roleResult.value.length} roles for ${incident.reference}:`);
        roleResult.value.forEach((role) => {
          logger.debug(
            `  - ${role.incident_role_id}: ${role.assignee ? role.assignee.id : 'unassigned'}`
          );
        });
      } else {
        logger.debug(
          `No roles mapped for ${incident.reference} (source had ${incident.incident_role_assignments?.length || 0})`
        );
      }
      if (customFieldResult.value && customFieldResult.value.length > 0) {
        createRequest.custom_field_entries = customFieldResult.value;
      }

      if (options.dryRun) {
        logger.info(
          `[DRY RUN] Would create: ${incident.reference} - ${incident.name} (${result.warnings.length} warnings)`
        );
        result.status = 'created';
        result.targetIncidentId = 'dry-run-id';
      } else {
        // Log the full request for debugging
        logger.debug(`Create request payload: ${JSON.stringify(createRequest, null, 2)}`);

        // Create incident
        const { incident: createdIncident } = await this.client.createIncident(createRequest);
        result.status = 'created';
        result.targetIncidentId = createdIncident.id;
        logger.info(
          `Created: ${incident.reference} -> ${createdIncident.reference} (${result.warnings.length} warnings)`
        );
      }
    } catch (error) {
      result.status = 'failed';
      result.error = (error as Error).message;
      logger.error(`Failed to import ${incident.reference}: ${result.error}`);
    }

    return result;
  }
}

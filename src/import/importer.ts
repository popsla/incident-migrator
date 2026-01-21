import { join } from 'path';
import { IncidentIoApiClient } from '../api/client.js';
import { logger } from '../util/logging.js';
import { readJsonl, readState, writeState, writeReport, fileExists, isDirectory } from '../util/fs.js';
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
  UpdateIncidentRequest,
  MappingContext,
  RetrospectiveIncidentOptions,
  Incident,
} from '../types.js';

export interface ImportOptions {
  inputPath: string;
  dryRun?: boolean;
  concurrency?: number;
  strict?: boolean;
  stateFile?: string;
  reportFile?: string;
  slackChannelId?: string;
  skipSlackChannel?: boolean;
  skipExternalId?: boolean;
  limit?: number;
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
      concurrency = 5,
      strict = false,
      stateFile = 'state.json',
      reportFile = 'import-report.json',
      skipSlackChannel = false,
      skipExternalId = false,
      limit,
    } = options;

    this.sourceContext = sourceContext;

    logger.info('Starting import...');
    if (dryRun) logger.info('[DRY RUN MODE] No changes will be made');

    // Load state for deduplication
    let state: ImportState = { mapping: {}, lastImportedAt: new Date().toISOString() };
    if (await fileExists(stateFile)) {
      const existingState = await readState(stateFile);
      if (existingState) {
        state = existingState;
        const count = Object.keys(state.mapping).length;
        if (count > 0) logger.info(`Found ${count} previously imported incident(s) in state`);
      }
    }

    // Build target context and reference map
    logger.info('Building target environment mapping context...');
    const targetContext = await buildMappingContext(this.client);

    logger.info('Building target incident reference map for deduplication...');
    const targetIncidentsByRef = await this.client.buildIncidentReferenceMap();
    logger.info(`Found ${targetIncidentsByRef.size} existing incidents in target`);

    // Read incidents from export
    let inputFile = inputPath;
    if (await isDirectory(inputPath)) inputFile = join(inputPath, 'incidents.jsonl');

    logger.info(`Reading incidents from ${inputFile}...`);
    const bundles: IncidentBundle[] = [];
    for await (const bundle of readJsonl<IncidentBundle>(inputFile)) {
      bundle.incident = normalizeIncident(bundle.incident);
      bundles.push(bundle);
      if (limit && bundles.length >= limit) break;
    }
    logger.info(`Found ${bundles.length} incidents to import${limit ? ` (limited to ${limit})` : ''}`);

    // Process incidents with concurrency
    const results: ImportResult[] = [];
    const queue = [...bundles];
    const workers: Promise<void>[] = [];

    for (let i = 0; i < concurrency; i++) {
      workers.push((async () => {
        while (queue.length > 0) {
          const bundle = queue.shift();
          if (!bundle) break;

          const result = await this.importIncident(bundle, targetContext, state, {
            dryRun, strict, skipSlackChannel, skipExternalId
          }, targetIncidentsByRef);

          results.push(result);
          if ((result.status === 'created' || result.status === 'updated') && result.targetIncidentId) {
            state.mapping[bundle.incident.id] = result.targetIncidentId;
          }
          if (results.length % 10 === 0) logger.info(`Processed ${results.length}/${bundles.length} incidents...`);
        }
      })());
    }
    await Promise.all(workers);

    // Save state and report
    state.lastImportedAt = new Date().toISOString();
    if (!dryRun) {
      await writeState(stateFile, state);
      await writeReport(reportFile, {
        importedAt: new Date().toISOString(),
        summary: {
          total: results.length,
          created: results.filter(r => r.status === 'created').length,
          updated: results.filter(r => r.status === 'updated').length,
          skipped: results.filter(r => r.status === 'skipped').length,
          failed: results.filter(r => r.status === 'failed').length,
        },
        results,
      } as ImportReport);
    }

    // Print summary
    const summary = {
      total: results.length,
      created: results.filter(r => r.status === 'created').length,
      updated: results.filter(r => r.status === 'updated').length,
      skipped: results.filter(r => r.status === 'skipped').length,
      failed: results.filter(r => r.status === 'failed').length,
    };

    logger.success('Import complete!');
    logger.info(`Total: ${summary.total}`);
    logger.info(`  Created: ${summary.created}`);
    logger.info(`  Updated: ${summary.updated}`);
    logger.info(`  Skipped: ${summary.skipped}`);
    logger.info(`  Failed: ${summary.failed}`);

    const allWarnings = results.flatMap(r => r.warnings);
    if (allWarnings.length > 0) {
      logger.warn(`Total warnings: ${allWarnings.length}`);
      [...new Set(allWarnings)].slice(0, 5).forEach(w => logger.warn(`  - ${w}`));
      if (allWarnings.length > 5) logger.warn(`  ... and ${allWarnings.length - 5} more (see ${reportFile})`);
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
    options: { dryRun: boolean; strict: boolean; skipSlackChannel?: boolean; skipExternalId?: boolean },
    targetIncidentsByRef: Map<string, Incident>
  ): Promise<ImportResult> {
    const { incident } = bundle;
    const result: ImportResult = { sourceIncidentId: incident.id, status: 'failed', warnings: [] };

    try {
      // Find existing incident (state.json first, then by reference)
      let existingIncidentId = state.mapping[incident.id];
      if (!existingIncidentId) {
        const byRef = targetIncidentsByRef.get(incident.reference);
        if (byRef) {
          existingIncidentId = byRef.id;
          state.mapping[incident.id] = existingIncidentId;
        }
      }

      // Map all fields
      const severityResult = mapSeverity(incident.severity, targetContext.severities);
      const statusResult = mapStatus(incident.status, targetContext.statuses);
      const typeResult = mapIncidentType(incident.incident_type, targetContext.types);
      const timestampResult = mapTimestampsWithContext(
        incident.incident_timestamp_values,
        this.sourceContext?.timestamps || new Map(),
        targetContext.timestamps
      );
      const roleResult = mapRoleAssignments(
        incident.incident_role_assignments,
        this.sourceContext?.roles || new Map(),
        targetContext.roles,
        targetContext.users
      );
      const customFieldResult = mapCustomFieldValues(
        incident.custom_field_values,
        this.sourceContext?.customFields || new Map(),
        targetContext.customFields,
        targetContext.catalogEntries
      );

      result.warnings.push(
        ...severityResult.warnings,
        ...statusResult.warnings,
        ...typeResult.warnings,
        ...timestampResult.warnings,
        ...roleResult.warnings,
        ...customFieldResult.warnings
      );

      if (options.strict && !severityResult.value) throw new Error('Severity mapping failed');
      if (options.strict && !statusResult.value) throw new Error('Status mapping failed');

      // Adjust visibility for incident types that require private
      let visibility = incident.visibility;
      if (typeResult.value) {
        const targetType = targetContext.types.get(typeResult.value);
        if (targetType?.private_incidents_only && visibility === 'public') {
          visibility = 'private';
          result.warnings.push(`Visibility changed to private (incident type "${targetType.name}" requires private)`);
        }
      }

      // Dry run
      if (options.dryRun) {
        if (existingIncidentId) {
          logger.info(`[DRY RUN] Would update: ${incident.reference} (${result.warnings.length} warnings)`);
          result.status = 'updated';
          result.targetIncidentId = existingIncidentId;
        } else {
          logger.info(`[DRY RUN] Would create: ${incident.reference} - ${incident.name} (${result.warnings.length} warnings)`);
          result.status = 'created';
          result.targetIncidentId = 'dry-run-id';
        }
        return result;
      }

      // Update existing incident
      if (existingIncidentId) {
        const updated = await this.updateIncident(existingIncidentId, incident, {
          severityResult, timestampResult, roleResult, customFieldResult
        }, targetContext);
        result.status = 'updated';
        result.targetIncidentId = updated.id;
        logger.info(`Updated: ${incident.reference} -> ${updated.reference} (${result.warnings.length} warnings)`);
        return result;
      }

      // Create new incident
      const created = await this.createIncident(incident, {
        severityResult, statusResult, typeResult, timestampResult, roleResult, customFieldResult,
        visibility, skipSlackChannel: options.skipSlackChannel, skipExternalId: options.skipExternalId
      }, targetIncidentsByRef, state, result);

      result.status = 'created';
      result.targetIncidentId = created.id;
      logger.info(`Created: ${incident.reference} -> ${created.reference} (${result.warnings.length} warnings)`);

      // Attach Jira ticket if present
      if (incident.external_issue_reference?.provider === 'jira' && incident.external_issue_reference.issue_permalink) {
        try {
          await this.client.createIncidentAttachment(created.id, {
            external_id: incident.external_issue_reference.issue_permalink,
            resource_type: 'jira_issue',
          });
        } catch (e) {
          result.warnings.push(`Failed to attach Jira ticket: ${(e as Error).message}`);
        }
      }

      return result;
    } catch (error) {
      result.status = 'failed';
      result.error = (error as Error).message;
      logger.error(`Failed to import ${incident.reference}: ${result.error}`);
      return result;
    }
  }

  private async updateIncident(
    targetId: string,
    incident: Incident,
    mapped: {
      severityResult: { value?: string };
      timestampResult: { value?: any[] };
      roleResult: { value?: any[] };
      customFieldResult: { value?: any[] };
    },
    targetContext: MappingContext
  ): Promise<Incident> {
    const updateRequest: UpdateIncidentRequest = {
      incident: { name: incident.name, summary: incident.summary },
      notify_incident_channel: false,
    };

    if (mapped.severityResult.value) updateRequest.incident.severity_id = mapped.severityResult.value;
    if (mapped.timestampResult.value?.length) updateRequest.incident.incident_timestamp_values = mapped.timestampResult.value;
    if (mapped.customFieldResult.value?.length) updateRequest.incident.custom_field_entries = mapped.customFieldResult.value;

    // Filter out reporter role (cannot be changed)
    if (mapped.roleResult.value?.length) {
      const nonReporter = mapped.roleResult.value.filter(r => {
        const role = targetContext.roles.get(r.incident_role_id);
        return role?.role_type !== 'reporter';
      });
      if (nonReporter.length) updateRequest.incident.incident_role_assignments = nonReporter;
    }

    const { incident: updated } = await this.client.updateIncident(targetId, updateRequest);
    return updated;
  }

  private async createIncident(
    incident: Incident,
    mapped: {
      severityResult: { value?: string };
      statusResult: { value?: string };
      typeResult: { value?: string };
      timestampResult: { value?: any[] };
      roleResult: { value?: any[] };
      customFieldResult: { value?: any[] };
      visibility: 'public' | 'private';
      skipSlackChannel?: boolean;
      skipExternalId?: boolean;
    },
    targetIncidentsByRef: Map<string, Incident>,
    state: ImportState,
    result: ImportResult
  ): Promise<Incident> {
    const retrospectiveOptions: RetrospectiveIncidentOptions = {};

    // Set external_id to preserve incident number
    if (!mapped.skipExternalId) {
      const match = incident.reference.match(/\d+$/);
      if (match) retrospectiveOptions.external_id = parseInt(match[0], 10);
    }

    if (incident.postmortem_document_url) {
      retrospectiveOptions.postmortem_document_url = incident.postmortem_document_url;
    }

    // MS Teams: use fake channel ID to prevent channel creation
    if (mapped.skipSlackChannel) {
      retrospectiveOptions.slack_channel_id = `C${incident.id.replace(/[^A-Z0-9]/gi, '').substring(0, 10).toUpperCase()}`;
    }

    const createRequest: CreateIncidentRequest = {
      mode: 'retrospective',
      name: incident.name,
      summary: incident.summary,
      visibility: mapped.visibility,
      idempotency_key: `retro-import:${incident.id}`,
      retrospective_incident_options: retrospectiveOptions,
    };

    if (mapped.severityResult.value) createRequest.severity_id = mapped.severityResult.value;
    if (mapped.statusResult.value) createRequest.incident_status_id = mapped.statusResult.value;
    if (mapped.typeResult.value) createRequest.incident_type_id = mapped.typeResult.value;
    if (mapped.timestampResult.value?.length) createRequest.incident_timestamp_values = mapped.timestampResult.value;
    if (mapped.roleResult.value?.length) createRequest.incident_role_assignments = mapped.roleResult.value;
    if (mapped.customFieldResult.value?.length) createRequest.custom_field_entries = mapped.customFieldResult.value;

    try {
      const { incident: created } = await this.client.createIncident(createRequest);
      return created;
    } catch (createError) {
      const errorMessage = (createError as Error).message;

      // External ID conflict means incident exists - find and update it
      if (errorMessage.includes('external ID already exists')) {
        const existing = targetIncidentsByRef.get(incident.reference);
        if (existing) {
          result.warnings.push(`Incident ${incident.reference} already exists, updating instead`);
          const updated = await this.updateIncident(existing.id, incident, {
            severityResult: mapped.severityResult,
            timestampResult: mapped.timestampResult,
            roleResult: mapped.roleResult,
            customFieldResult: mapped.customFieldResult,
          }, { roles: new Map() } as MappingContext);
          state.mapping[incident.id] = updated.id;
          result.status = 'updated';
          return updated;
        }
        throw new Error(`External ID ${incident.reference} exists but incident not found`);
      }
      throw createError;
    }
  }
}

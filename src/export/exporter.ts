import { join } from 'path';
import { IncidentIoApiClient, paginateAll } from '../api/client.js';
import { logger } from '../util/logging.js';
import { appendJsonl, writeManifest } from '../util/fs.js';
import type { IncidentBundle, ExportManifest } from '../types.js';

export interface ExportOptions {
  outputDir: string;
  createdAfter?: string;
  createdBefore?: string;
  statusCategory?: string;
  limit?: number;
}

export class Exporter {
  private client: IncidentIoApiClient;

  constructor(client: IncidentIoApiClient) {
    this.client = client;
  }

  async export(options: ExportOptions): Promise<void> {
    const { outputDir, createdAfter, createdBefore, statusCategory, limit } = options;
    const outputFile = join(outputDir, 'incidents.jsonl');
    const manifestFile = join(outputDir, 'manifest.json');

    logger.info('Starting export...');
    logger.info(`Output: ${outputFile}`);

    let count = 0;
    let followUpCount = 0;
    let updateCount = 0;

    // Build query params
    const queryParams: Record<string, string> = {};
    if (statusCategory) {
      queryParams['status_category[]'] = statusCategory;
    }

    // Note: created_after/created_before filtering would need to be done client-side
    // if the API doesn't support these params directly on the list endpoint

    for await (const incident of paginateAll(
      (after) =>
        this.client.listIncidents({
          page_size: 100,
          after,
          status_category: statusCategory,
        }),
      (response) => response.incidents || []
    )) {
      // Apply client-side filters
      if (createdAfter && incident.created_at < createdAfter) {
        continue;
      }
      if (createdBefore && incident.created_at > createdBefore) {
        continue;
      }

      // Fetch additional details
      logger.debug(`Exporting incident ${incident.reference} (${incident.name})`);

      const bundle: IncidentBundle = {
        incident,
      };

      // Fetch follow-ups
      try {
        const { follow_ups } = await this.client.listFollowUps(incident.id);
        if (follow_ups && follow_ups.length > 0) {
          bundle.follow_ups = follow_ups;
          followUpCount += follow_ups.length;
        }
      } catch (error) {
        logger.warn(
          `Failed to fetch follow-ups for incident ${incident.reference}: ${(error as Error).message}`
        );
      }

      // Fetch incident updates
      try {
        const { incident_updates } = await this.client.listIncidentUpdates(incident.id);
        if (incident_updates && incident_updates.length > 0) {
          bundle.incident_updates = incident_updates;
          updateCount += incident_updates.length;
        }
      } catch (error) {
        logger.warn(
          `Failed to fetch incident updates for incident ${incident.reference}: ${(error as Error).message}`
        );
      }

      // Write to JSONL
      await appendJsonl(outputFile, bundle);

      count++;
      if (count % 10 === 0) {
        logger.info(`Exported ${count} incidents...`);
      }

      if (limit && count >= limit) {
        logger.info(`Reached limit of ${limit} incidents`);
        break;
      }
    }

    // Write manifest
    const manifest: ExportManifest = {
      exportedAt: new Date().toISOString(),
      filters: {
        createdAfter,
        createdBefore,
        statusCategory,
        limit,
      },
      counts: {
        incidents: count,
        followUps: followUpCount,
        incidentUpdates: updateCount,
      },
      sourceBaseUrl: this.client['baseUrl'],
    };

    await writeManifest(manifestFile, manifest);

    logger.success(`Export complete!`);
    logger.info(`Exported ${count} incidents`);
    logger.info(`  - ${followUpCount} follow-ups`);
    logger.info(`  - ${updateCount} incident updates`);
    logger.info(`Manifest: ${manifestFile}`);
  }
}

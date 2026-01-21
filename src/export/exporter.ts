import { join } from 'path';
import { IncidentIoApiClient, paginateAll } from '../api/client.js';
import { logger } from '../util/logging.js';
import { appendJsonl, clearFile, writeManifest } from '../util/fs.js';
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

    // Clear existing file to prevent duplicates on re-export
    await clearFile(outputFile);

    let count = 0;
    let followUpCount = 0;
    let updateCount = 0;
    let relatedCount = 0;

    // build query params
    const queryParams: Record<string, string> = {};
    if (statusCategory) {
      queryParams['status_category[]'] = statusCategory;
    }

    // created_after/created_before filtering is done client-side

    for await (const incident of paginateAll(
      (after) =>
        this.client.listIncidents({
          page_size: 100,
          after,
          status_category: statusCategory,
        }),
      (response) => response.incidents || []
    )) {
      // apply client-side filters
      if (createdAfter && incident.created_at < createdAfter) {
        continue;
      }
      if (createdBefore && incident.created_at > createdBefore) {
        continue;
      }

      // fetch additional details
      logger.debug(`Exporting incident ${incident.reference} (${incident.name})`);

      const bundle: IncidentBundle = {
        incident,
      };

      // fetch follow-ups
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

      // fetch incident updates
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

      // fetch related incidents
      try {
        const { incident_relationships } = await this.client.listRelatedIncidents(incident.id);
        if (incident_relationships && incident_relationships.length > 0) {
          bundle.related_incidents = incident_relationships;
          relatedCount += incident_relationships.length;
        }
      } catch (error) {
        logger.warn(
          `Failed to fetch related incidents for incident ${incident.reference}: ${(error as Error).message}`
        );
      }

      // write to jsonl
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

    // write manifest
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
        relatedIncidents: relatedCount,
      },
      sourceBaseUrl: this.client['baseUrl'],
    };

    await writeManifest(manifestFile, manifest);

    logger.success(`Export complete!`);
    logger.info(`Exported ${count} incidents`);
    logger.info(`  - ${followUpCount} follow-ups`);
    logger.info(`  - ${updateCount} incident updates`);
    logger.info(`  - ${relatedCount} related incidents`);
    logger.info(`Manifest: ${manifestFile}`);
  }
}

import { IncidentIoApiClient, paginateAll } from '../api/client.js';
import { logger } from '../util/logging.js';
import type { MappingContext, CatalogEntry } from '../types.js';

export async function buildMappingContext(
  client: IncidentIoApiClient
): Promise<MappingContext> {
  logger.info('Building mapping context...');

  // fetch all configuration data
  const [
    { severities },
    { incident_statuses },
    { incident_types },
    { custom_fields },
    { incident_timestamps },
    { incident_roles },
  ] = await Promise.all([
    client.listSeverities(),
    client.listIncidentStatuses(),
    client.listIncidentTypes(),
    client.listCustomFields(),
    client.listIncidentTimestamps(),
    client.listIncidentRoles(),
  ]);

  // fetch all users with pagination
  const users = [];
  for await (const user of paginateAll(
    (after) => client.listUsers({ page_size: 100, after }),
    (response) => response.users || []
  )) {
    users.push(user);
  }

  // fetch catalog entries for catalog-backed custom fields
  const catalogEntries = new Map<string, CatalogEntry[]>();
  const catalogTypeIds = new Set<string>();
  for (const field of custom_fields) {
    if (field.catalog_type_id) {
      catalogTypeIds.add(field.catalog_type_id);
    }
  }

  for (const catalogTypeId of catalogTypeIds) {
    const entries: CatalogEntry[] = [];
    for await (const entry of paginateAll(
      (after) => client.listCatalogEntries(catalogTypeId, { page_size: 100, after }),
      (response) => response.catalog_entries || []
    )) {
      entries.push(entry);
    }
    catalogEntries.set(catalogTypeId, entries);
  }

  logger.info(
    `Loaded: ${severities.length} severities, ${incident_statuses.length} statuses, ` +
      `${incident_types.length} types, ${custom_fields.length} custom fields, ` +
      `${incident_timestamps.length} timestamps, ${incident_roles.length} roles, ` +
      `${users.length} users, ${catalogTypeIds.size} catalog types`
  );

  return {
    severities: new Map(severities.map((s) => [s.id, s])),
    statuses: new Map(incident_statuses.map((s) => [s.id, s])),
    types: new Map(incident_types.map((t) => [t.id, t])),
    customFields: new Map(custom_fields.map((f) => [f.id, f])),
    timestamps: new Map(incident_timestamps.map((t) => [t.id, t])),
    roles: new Map(incident_roles.map((r) => [r.id, r])),
    users: new Map(users.map((u) => [u.id, u])),
    catalogEntries,
  };
}

export * from './mappers.js';

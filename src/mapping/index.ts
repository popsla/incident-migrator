import { IncidentIoApiClient, paginateAll } from '../api/client.js';
import { logger } from '../util/logging.js';
import type { CatalogEntry, CustomField, CustomFieldOption, MappingContext } from '../types.js';

type CatalogEntriesPage = {
  catalog_entries: CatalogEntry[];
  pagination_meta?: { after?: string; page_size?: number; total_record_count?: number };
};

type CustomFieldOptionsPage = {
  custom_field_options: CustomFieldOption[];
  pagination_meta?: { after?: string; page_size?: number; total_record_count?: number };
};

export async function buildMappingContext(client: IncidentIoApiClient): Promise<MappingContext> {
  logger.info('Building mapping context...');

  // Fetch all configuration data (except custom fields which can be paginated)
  const [
    { severities },
    { incident_statuses },
    { incident_types },
    { incident_timestamps },
    { incident_roles },
  ] = await Promise.all([
    client.listSeverities(),
    client.listIncidentStatuses(),
    client.listIncidentTypes(),
    client.listIncidentTimestamps(),
    client.listIncidentRoles(),
  ]);

  // Fetch all custom fields with pagination (V2)
  const custom_fields: CustomField[] = [];
  for await (const field of paginateAll(
    (after) => client.listCustomFieldsV2({ page_size: 100, after }),
    (response) => response.custom_fields || []
  )) {
    custom_fields.push(field);
  }

  // For select fields (single/multi) that are NOT catalog-backed, load options via Custom Field Options V1.
  // Note: /v2/custom_fields does not include options (options_len is often 0), even though the UI shows them.
  const selectFieldsNeedingOptions = custom_fields.filter(
    (f) =>
      (f.field_type === 'single_select' || f.field_type === 'multi_select') &&
      !f.catalog_type_id
  );

  for (const field of selectFieldsNeedingOptions) {
    const options: CustomFieldOption[] = [];
    for await (const opt of paginateAll<CustomFieldOption, CustomFieldOptionsPage>(
      (after) =>
        client.listCustomFieldOptionsV1({
          custom_field_id: field.id,
          page_size: 100,
          after,
        }) as Promise<CustomFieldOptionsPage>,
      (response) => response.custom_field_options || []
    )) {
      options.push(opt);
    }
    field.options = options;
  }

  // Fetch all users with pagination
  const users = [];
  for await (const user of paginateAll(
    (after) => client.listUsers({ page_size: 100, after }),
    (response) => response.users || []
  )) {
    users.push(user);
  }

  // For catalog-backed custom fields, load catalog entries so we can map values by external_id/aliases/name.
  const catalogTypeIds = [
    ...new Set(custom_fields.map((f) => f.catalog_type_id).filter(Boolean)),
  ] as string[];
  const catalogEntriesByType: Map<string, Map<string, CatalogEntry>> = new Map();
  let totalCatalogEntries = 0;

  const normalizeKey = (s: string): string => s.trim().toLowerCase();

  for (const typeId of catalogTypeIds) {
    const entries: CatalogEntry[] = [];
    for await (const entry of paginateAll<CatalogEntry, CatalogEntriesPage>(
      (after) =>
        client.listCatalogEntriesV2({
          catalog_type_id: typeId,
          page_size: 100,
          after,
        }) as Promise<CatalogEntriesPage>,
      (response) => response.catalog_entries || []
    )) {
      entries.push(entry);
    }
    totalCatalogEntries += entries.length;

    // Build deterministic lookup key -> entry (prefer lowest id if collisions)
    const index = new Map<string, CatalogEntry>();
    for (const e of entries) {
      const keys = [
        e.external_id ? normalizeKey(e.external_id) : undefined,
        normalizeKey(e.name),
        ...(e.aliases || []).map((a) => normalizeKey(a)),
      ].filter(Boolean) as string[];

      for (const key of keys) {
        const existing = index.get(key);
        if (!existing || e.id.localeCompare(existing.id) < 0) {
          index.set(key, e);
        }
      }
    }
    catalogEntriesByType.set(typeId, index);
  }

  logger.info(
    `Loaded: ${severities.length} severities, ${incident_statuses.length} statuses, ` +
      `${incident_types.length} types, ${custom_fields.length} custom fields, ` +
      `${catalogTypeIds.length} catalog type(s), ${totalCatalogEntries} catalog entries, ` +
      `${incident_timestamps.length} timestamps, ${incident_roles.length} roles, ` +
      `${users.length} users`
  );

  return {
    severities: new Map(severities.map((s) => [s.id, s])),
    statuses: new Map(incident_statuses.map((s) => [s.id, s])),
    types: new Map(incident_types.map((t) => [t.id, t])),
    customFields: new Map(custom_fields.map((f) => [f.id, f])),
    catalogEntriesByType,
    timestamps: new Map(incident_timestamps.map((t) => [t.id, t])),
    roles: new Map(incident_roles.map((r) => [r.id, r])),
    users: new Map(users.map((u) => [u.id, u])),
  };
}

export * from './mappers.js';

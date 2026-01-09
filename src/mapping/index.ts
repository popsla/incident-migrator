import { IncidentIoApiClient, paginateAll } from '../api/client.js';
import { logger } from '../util/logging.js';
import type { MappingContext } from '../types.js';

export async function buildMappingContext(
  client: IncidentIoApiClient
): Promise<MappingContext> {
  logger.info('Building mapping context...');

  // Fetch all configuration data
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

  // Fetch all users with pagination
  const users = [];
  for await (const user of paginateAll(
    (after) => client.listUsers({ page_size: 100, after }),
    (response) => response.users || []
  )) {
    users.push(user);
  }

  logger.info(
    `Loaded: ${severities.length} severities, ${incident_statuses.length} statuses, ` +
      `${incident_types.length} types, ${custom_fields.length} custom fields, ` +
      `${incident_timestamps.length} timestamps, ${incident_roles.length} roles, ` +
      `${users.length} users`
  );

  return {
    severities: new Map(severities.map((s) => [s.id, s])),
    statuses: new Map(incident_statuses.map((s) => [s.id, s])),
    types: new Map(incident_types.map((t) => [t.id, t])),
    customFields: new Map(custom_fields.map((f) => [f.id, f])),
    timestamps: new Map(incident_timestamps.map((t) => [t.id, t])),
    roles: new Map(incident_roles.map((r) => [r.id, r])),
    users: new Map(users.map((u) => [u.id, u])),
  };
}

export * from './mappers.js';

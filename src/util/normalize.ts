import type {
  Incident,
  IncidentTimestampValue,
  IncidentTimestampValueResponse,
  IncidentRoleAssignment,
} from '../types.js';

// Normalize incident data from API response format to our internal format
export function normalizeIncident(incident: any): Incident {
  // Normalize timestamp values from nested format to flat format
  const normalizedTimestamps: IncidentTimestampValue[] = [];
  if (incident.incident_timestamp_values) {
    for (const ts of incident.incident_timestamp_values as IncidentTimestampValueResponse[]) {
      // Only include timestamps that have actual values set
      if (ts.value?.value) {
        normalizedTimestamps.push({
          incident_timestamp_id: ts.incident_timestamp.id,
          value: ts.value.value,
        });
      }
    }
  }

  // Normalize role assignments from nested format to flat format
  const normalizedRoles: IncidentRoleAssignment[] = [];
  if (incident.incident_role_assignments) {
    for (const roleAssignment of incident.incident_role_assignments as any[]) {
      normalizedRoles.push({
        incident_role_id: roleAssignment.role.id,
        assignee: roleAssignment.assignee
          ? {
              id: roleAssignment.assignee.id,
              email: roleAssignment.assignee.email,
            }
          : undefined,
      });
    }
  }

  // Normalize severity, status, and incident_type if they're objects
  // The API returns full objects but we only need IDs for mapping
  const normalizedIncident = {
    ...incident,
    incident_timestamp_values: normalizedTimestamps,
    incident_role_assignments: normalizedRoles,
  };

  // Keep severity/status/type as objects for mapping (they contain name/category)
  // but ensure they're in the expected format
  if (incident.severity && typeof incident.severity === 'object') {
    normalizedIncident.severity = incident.severity;
  }
  if (incident.status && typeof incident.status === 'object') {
    normalizedIncident.status = incident.status;
  }
  if (incident.incident_type && typeof incident.incident_type === 'object') {
    normalizedIncident.incident_type = incident.incident_type;
  }

  return normalizedIncident as Incident;
}

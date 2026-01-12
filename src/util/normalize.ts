import type {
  Incident,
  IncidentTimestampValue,
  IncidentTimestampValueResponse,
  IncidentRoleAssignment,
} from '../types.js';

// Normalize incident data from API response format to our internal format
export function normalizeIncident(incident: any): Incident {
  // Normalize timestamp values from nested format to include both ID and name
  // Keep the full incident_timestamp object so we don't need source context for mapping
  const normalizedTimestamps: IncidentTimestampValue[] = [];
  if (incident.incident_timestamp_values) {
    for (const ts of incident.incident_timestamp_values as IncidentTimestampValueResponse[]) {
      // Only include timestamps that have actual values set
      if (ts.value?.value) {
        normalizedTimestamps.push({
          incident_timestamp_id: ts.incident_timestamp.id,
          incident_timestamp: ts.incident_timestamp, // Keep the full object with name
          value: ts.value.value,
        });
      }
    }
  }

  // Normalize role assignments from nested format to include both ID and name
  // Keep the full role object so we don't need source context for mapping
  const normalizedRoles: IncidentRoleAssignment[] = [];
  if (incident.incident_role_assignments) {
    for (const roleAssignment of incident.incident_role_assignments as any[]) {
      normalizedRoles.push({
        incident_role_id: roleAssignment.role.id,
        role: roleAssignment.role, // Keep the full object with name
        assignee: roleAssignment.assignee
          ? {
              id: roleAssignment.assignee.id,
              email: roleAssignment.assignee.email,
            }
          : undefined,
      });
    }
  }

  // Normalize custom field entries from nested format to include both ID and name
  // API returns custom_field_entries but we normalize to custom_field_values
  const normalizedCustomFields: any[] = [];
  if (incident.custom_field_entries) {
    for (const entry of incident.custom_field_entries as any[]) {
      normalizedCustomFields.push({
        custom_field_id: entry.custom_field.id,
        custom_field: entry.custom_field, // Keep the full object with name and options
        values: entry.values, // Keep as array to match API format
      });
    }
  }

  const normalizedIncident = {
    ...incident,
    incident_timestamp_values: normalizedTimestamps,
    incident_role_assignments: normalizedRoles,
    custom_field_values: normalizedCustomFields,
  };

  // Map incident_status → status (API returns incident_status, not status)
  if (incident.incident_status && typeof incident.incident_status === 'object') {
    normalizedIncident.status = incident.incident_status;
  } else if (incident.status && typeof incident.status === 'object') {
    normalizedIncident.status = incident.status;
  }

  // Keep severity and incident_type as objects if they exist
  if (incident.severity && typeof incident.severity === 'object') {
    normalizedIncident.severity = incident.severity;
  }
  if (incident.incident_type && typeof incident.incident_type === 'object') {
    normalizedIncident.incident_type = incident.incident_type;
  }

  return normalizedIncident as Incident;
}

// API Types for incident.io V2

// Response format (from GET /incidents)
export interface IncidentTimestampValueResponse {
  incident_timestamp: {
    id: string;
    name: string;
    rank: number;
  };
  value?: {
    value: string; // ISO 8601
  };
}

// Request format (for POST /incidents)
export interface IncidentTimestampValue {
  incident_timestamp_id: string;
  incident_timestamp?: IncidentTimestamp; // Full object preserved from export for mapping
  value: string; // ISO 8601
}

export interface CustomFieldValue {
  custom_field_id: string;
  custom_field?: CustomField; // Full object preserved from export for mapping
  values?: any[]; // Array format that the API expects
}

export interface IncidentRoleAssignment {
  incident_role_id: string;
  role?: IncidentRole; // Full object preserved from export for mapping
  assignee?: {
    id: string;
    email?: string;
  };
}

export interface RetrospectiveIncidentOptions {
  external_id?: number;
  postmortem_document_url?: string;
  slack_channel_id?: string;
  slack_channel_name?: string;
  slack_team_id?: string;
}

export interface Incident {
  id: string;
  reference: string;
  name: string;
  summary?: string;
  visibility: 'public' | 'private';
  severity?: {
    id: string;
    name: string;
    rank: number;
  };
  status?: {
    id: string;
    name: string;
    category: string;
  };
  incident_type?: {
    id: string;
    name: string;
  };
  custom_field_values?: CustomFieldValue[];
  incident_timestamp_values?: IncidentTimestampValue[];
  incident_role_assignments?: IncidentRoleAssignment[];
  postmortem_document_url?: string;
  created_at: string;
  updated_at: string;
  mode: 'standard' | 'retrospective' | 'test' | 'tutorial';
  creator?: {
    id: string;
    email?: string;
    name?: string;
  };
  slack_channel_id?: string;
  slack_channel_name?: string;
  external_id?: string;
}

export interface FollowUp {
  id: string;
  title: string;
  description?: string;
  status: string;
  priority: string;
  assignee?: {
    id: string;
    email?: string;
  };
  incident_id: string;
  created_at: string;
  updated_at: string;
  completed_at?: string;
}

export interface IncidentUpdate {
  id: string;
  incident_id: string;
  message: string;
  new_severity_id?: string;
  new_status_id?: string;
  created_at: string;
  updater: {
    id: string;
    email?: string;
  };
}

export interface Severity {
  id: string;
  name: string;
  rank: number;
  description?: string;
}

export interface IncidentStatus {
  id: string;
  name: string;
  category: 'triage' | 'declined' | 'merged' | 'canceled' | 'live' | 'learning' | 'closed';
  description?: string;
  rank: number;
}

export interface IncidentType {
  id: string;
  name: string;
  description?: string;
}

export interface CustomField {
  id: string;
  name: string;
  field_type: 'single_select' | 'multi_select' | 'text' | 'link' | 'numeric';
  catalog_type_id?: string;
  options?: CustomFieldOption[];
}

export interface CustomFieldOption {
  id: string;
  value: string;
  sort_key: number;
  custom_field_id: string;
}

export interface IncidentTimestamp {
  id: string;
  name: string;
  rank: number;
}

export interface IncidentRole {
  id: string;
  name: string;
  role_type: 'lead' | 'reporter' | 'custom';
  required: boolean;
}

export interface User {
  id: string;
  email: string;
  name?: string;
  slack_user_id?: string;
}

// Export bundle schema
export interface IncidentBundle {
  incident: Incident;
  follow_ups?: FollowUp[];
  incident_updates?: IncidentUpdate[];
}

// API Response wrappers
export interface PaginatedResponse<T> {
  pagination_meta?: {
    after?: string;
    page_size?: number;
    total_record_count?: number;
  };
  [key: string]: T[] | unknown;
}

// Create incident request
export interface CreateIncidentRequest {
  mode: 'retrospective';
  name: string;
  summary?: string;
  visibility: 'public' | 'private';
  severity_id?: string;
  incident_status_id?: string;  // Note: API uses incident_status_id not status_id
  incident_type_id?: string;
  custom_field_entries?: CustomFieldValue[];  // Note: API uses custom_field_entries not custom_field_values
  incident_timestamp_values?: IncidentTimestampValue[];
  incident_role_assignments?: IncidentRoleAssignment[];
  retrospective_incident_options?: RetrospectiveIncidentOptions;
  idempotency_key?: string;
}

// Configuration
export interface Config {
  sourceApiKey: string;
  targetApiKey: string;
  sourceBaseUrl: string;
  targetBaseUrl: string;
}

// Export manifest
export interface ExportManifest {
  exportedAt: string;
  filters: {
    createdAfter?: string;
    createdBefore?: string;
    statusCategory?: string;
    limit?: number;
  };
  counts: {
    incidents: number;
    followUps: number;
    incidentUpdates: number;
  };
  sourceBaseUrl: string;
}

// Import state
export interface ImportState {
  mapping: Record<string, string>; // source_incident_id -> target_incident_id
  lastImportedAt: string;
}

// Import result
export interface ImportResult {
  sourceIncidentId: string;
  targetIncidentId?: string;
  status: 'created' | 'skipped' | 'failed';
  warnings: string[];
  error?: string;
}

// Import report
export interface ImportReport {
  importedAt: string;
  summary: {
    total: number;
    created: number;
    skipped: number;
    failed: number;
  };
  results: ImportResult[];
}

// Mapping context
export interface MappingContext {
  severities: Map<string, Severity>;
  statuses: Map<string, IncidentStatus>;
  types: Map<string, IncidentType>;
  customFields: Map<string, CustomField>;
  timestamps: Map<string, IncidentTimestamp>;
  roles: Map<string, IncidentRole>;
  users: Map<string, User>;
}

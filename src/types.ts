// api types for incident.io v2

// response format (from GET /incidents)
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

// request format (for POST /incidents)
export interface IncidentTimestampValue {
  incident_timestamp_id: string;
  incident_timestamp?: IncidentTimestamp;
  value: string; // ISO 8601
}

export interface CustomFieldValue {
  custom_field_id: string;
  custom_field?: CustomField;
  values?: any[];
}

export interface IncidentRoleAssignment {
  incident_role_id: string;
  role?: IncidentRole;
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

export interface ExternalIssueReference {
  provider: string;
  issue_name: string;
  issue_permalink: string;
}

export interface Incident {
  id: string;
  reference: string;
  name: string;
  summary?: string;
  visibility: 'public' | 'private';
  external_issue_reference?: ExternalIssueReference;
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
  private_incidents_only?: boolean;
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

export interface CatalogEntry {
  id: string;
  name: string;
  catalog_type_id: string;
  external_id?: string;
}

export interface IncidentRelationship {
  id: string;
  incident: {
    id: string;
    external_id?: number;
    name: string;
  };
}

// export bundle schema
export interface IncidentBundle {
  incident: Incident;
  follow_ups?: FollowUp[];
  incident_updates?: IncidentUpdate[];
  related_incidents?: IncidentRelationship[];
}

// api response wrappers
export interface PaginatedResponse<T> {
  pagination_meta?: {
    after?: string;
    page_size?: number;
    total_record_count?: number;
  };
  [key: string]: T[] | unknown;
}

// create incident request
export interface CreateIncidentRequest {
  mode: 'retrospective';
  name: string;
  summary?: string;
  visibility: 'public' | 'private';
  severity_id?: string;
  incident_status_id?: string;
  incident_type_id?: string;
  custom_field_entries?: CustomFieldValue[];
  incident_timestamp_values?: IncidentTimestampValue[];
  incident_role_assignments?: IncidentRoleAssignment[];
  retrospective_incident_options?: RetrospectiveIncidentOptions;
  idempotency_key?: string;
}

// update incident request
export interface UpdateIncidentRequest {
  incident: {
    name?: string;
    summary?: string;
    severity_id?: string;
    incident_status_id?: string;
    custom_field_entries?: CustomFieldValue[];
    incident_timestamp_values?: IncidentTimestampValue[];
    incident_role_assignments?: IncidentRoleAssignment[];
  };
  notify_incident_channel: boolean;
}

// configuration
export interface Config {
  sourceApiKey: string;
  targetApiKey: string;
  sourceBaseUrl: string;
  targetBaseUrl: string;
}

// export manifest
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
    relatedIncidents?: number;
  };
  sourceBaseUrl: string;
}

// import state
export interface ImportState {
  mapping: Record<string, string>; // source_incident_id -> target_incident_id
  lastImportedAt: string;
}

// import result
export interface ImportResult {
  sourceIncidentId: string;
  targetIncidentId?: string;
  status: 'created' | 'updated' | 'skipped' | 'failed';
  warnings: string[];
  error?: string;
}

// import report
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

// mapping context
export interface MappingContext {
  severities: Map<string, Severity>;
  statuses: Map<string, IncidentStatus>;
  types: Map<string, IncidentType>;
  customFields: Map<string, CustomField>;
  timestamps: Map<string, IncidentTimestamp>;
  roles: Map<string, IncidentRole>;
  users: Map<string, User>;
  catalogEntries: Map<string, CatalogEntry[]>; // keyed by catalog_type_id
}

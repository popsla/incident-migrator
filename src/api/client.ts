import { fetch } from 'undici';
import { logger } from '../util/logging.js';
import type {
  Incident,
  FollowUp,
  IncidentUpdate,
  Severity,
  IncidentStatus,
  IncidentType,
  CustomField,
  IncidentTimestamp,
  IncidentRole,
  User,
  CreateIncidentRequest,
} from '../types.js';

interface ApiClientOptions {
  apiKey: string;
  baseUrl: string;
  maxRetries?: number;
  retryDelay?: number;
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: Record<string, string>;
}

export class IncidentIoApiClient {
  private apiKey: string;
  private baseUrl: string;
  private maxRetries: number;
  private retryDelay: number;

  constructor(options: ApiClientOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.maxRetries = options.maxRetries ?? 5;
    this.retryDelay = options.retryDelay ?? 1000;
  }

  private async sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async request<T>(
    endpoint: string,
    options: RequestOptions = {}
  ): Promise<T> {
    const { method = 'GET', body, query } = options;
    let url = `${this.baseUrl}${endpoint}`;

    if (query) {
      const params = new URLSearchParams(query);
      url += `?${params.toString()}`;
    }

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        logger.debug(`${method} ${url} (attempt ${attempt + 1})`);

        const response = await fetch(url, {
          method,
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: body ? JSON.stringify(body) : undefined,
        });

        if (response.ok) {
          const data = await response.json();
          return data as T;
        }

        // Handle rate limiting
        if (response.status === 429) {
          const retryAfter = response.headers.get('retry-after');
          const waitMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : this.retryDelay * Math.pow(2, attempt);
          logger.warn(`Rate limited. Retrying after ${waitMs}ms...`);
          await this.sleep(waitMs);
          continue;
        }

        // Handle server errors with retry
        if (response.status >= 500) {
          const waitMs = this.retryDelay * Math.pow(2, attempt);
          logger.warn(`Server error (${response.status}). Retrying after ${waitMs}ms...`);
          await this.sleep(waitMs);
          continue;
        }

        // Handle client errors (no retry)
        const errorBody = await response.text();
        let errorMessage: string;
        try {
          const errorJson = JSON.parse(errorBody);
          errorMessage = JSON.stringify(errorJson, null, 2);
        } catch {
          errorMessage = errorBody;
        }
        throw new Error(`API error (${response.status}): ${errorMessage}`);
      } catch (error) {
        lastError = error as Error;
        if (error instanceof Error && !error.message.includes('API error')) {
          // Network error or other fetch error - retry
          const waitMs = this.retryDelay * Math.pow(2, attempt);
          logger.warn(`Request failed: ${error.message}. Retrying after ${waitMs}ms...`);
          await this.sleep(waitMs);
          continue;
        }
        throw error;
      }
    }

    throw lastError || new Error('Max retries exceeded');
  }

  // Incidents
  async listIncidents(params: {
    page_size?: number;
    after?: string;
    status_category?: string;
  } = {}): Promise<{ incidents: Incident[]; pagination_meta?: { after?: string; page_size?: number; total_record_count?: number } }> {
    const query: Record<string, string> = {};
    if (params.page_size) query.page_size = params.page_size.toString();
    if (params.after) query.after = params.after;
    if (params.status_category) query['status_category[]'] = params.status_category;

    return this.request<{ incidents: Incident[]; pagination_meta?: { after?: string; page_size?: number; total_record_count?: number } }>('/v2/incidents', { query });
  }

  async getIncident(id: string): Promise<{ incident: Incident }> {
    return this.request<{ incident: Incident }>(`/v2/incidents/${id}`);
  }

  async createIncident(data: CreateIncidentRequest): Promise<{ incident: Incident }> {
    return this.request<{ incident: Incident }>('/v2/incidents', {
      method: 'POST',
      body: data,
    });
  }

  // Follow-ups
  async listFollowUps(incidentId: string): Promise<{ follow_ups: FollowUp[] }> {
    return this.request<{ follow_ups: FollowUp[] }>('/v2/follow_ups', {
      query: { incident_id: incidentId },
    });
  }

  // Incident Updates
  async listIncidentUpdates(incidentId: string): Promise<{ incident_updates: IncidentUpdate[] }> {
    return this.request<{ incident_updates: IncidentUpdate[] }>('/v2/incident_updates', {
      query: { incident_id: incidentId },
    });
  }

  // Configuration endpoints
  async listSeverities(): Promise<{ severities: Severity[] }> {
    return this.request<{ severities: Severity[] }>('/v1/severities');
  }

  async listIncidentStatuses(): Promise<{ incident_statuses: IncidentStatus[] }> {
    return this.request<{ incident_statuses: IncidentStatus[] }>('/v1/incident_statuses');
  }

  async listIncidentTypes(): Promise<{ incident_types: IncidentType[] }> {
    return this.request<{ incident_types: IncidentType[] }>('/v1/incident_types');
  }

  async listCustomFields(): Promise<{ custom_fields: CustomField[] }> {
    return this.request<{ custom_fields: CustomField[] }>('/v2/custom_fields');
  }

  async listIncidentTimestamps(): Promise<{ incident_timestamps: IncidentTimestamp[] }> {
    return this.request<{ incident_timestamps: IncidentTimestamp[] }>('/v2/incident_timestamps');
  }

  async listIncidentRoles(): Promise<{ incident_roles: IncidentRole[] }> {
    return this.request<{ incident_roles: IncidentRole[] }>('/v2/incident_roles');
  }

  async listUsers(params: { page_size?: number; after?: string } = {}): Promise<{ users: User[]; pagination_meta?: { after?: string; page_size?: number; total_record_count?: number } }> {
    const query: Record<string, string> = {};
    if (params.page_size) query.page_size = params.page_size.toString();
    if (params.after) query.after = params.after;

    return this.request<{ users: User[]; pagination_meta?: { after?: string; page_size?: number; total_record_count?: number } }>('/v2/users', { query });
  }
}

// Pagination helper
export async function* paginateAll<T, R extends { pagination_meta?: { after?: string } }>(
  fetchPage: (after?: string) => Promise<R>,
  getItems: (response: R) => T[]
): AsyncGenerator<T> {
  let after: string | undefined;

  do {
    const response = await fetchPage(after);
    const items = getItems(response);

    for (const item of items) {
      yield item;
    }

    after = response.pagination_meta?.after;
  } while (after);
}

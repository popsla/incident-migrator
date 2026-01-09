import {
  mapSeverity,
  mapStatus,
  mapIncidentType,
  mapUser,
} from '../src/mapping/mappers';
import type { Severity, IncidentStatus, IncidentType, User } from '../src/types';

describe('Mapping Functions', () => {
  describe('mapSeverity', () => {
    const targetSeverities = new Map<string, Severity>([
      ['sev1', { id: 'sev1', name: 'Critical', rank: 1 }],
      ['sev2', { id: 'sev2', name: 'Major', rank: 2 }],
      ['sev3', { id: 'sev3', name: 'Minor', rank: 3 }],
    ]);

    it('should map by exact name match', () => {
      const source = { id: 'src1', name: 'Critical', rank: 1 };
      const result = mapSeverity(source, targetSeverities);

      expect(result.value).toBe('sev1');
      expect(result.warnings).toHaveLength(0);
    });

    it('should map by name case-insensitive', () => {
      const source = { id: 'src1', name: 'critical', rank: 1 };
      const result = mapSeverity(source, targetSeverities);

      expect(result.value).toBe('sev1');
      expect(result.warnings).toHaveLength(0);
    });

    it('should fallback to rank mapping when name not found', () => {
      const source = { id: 'src1', name: 'P1', rank: 1 };
      const result = mapSeverity(source, targetSeverities);

      expect(result.value).toBe('sev1');
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('mapped to');
    });

    it('should handle undefined source', () => {
      const result = mapSeverity(undefined, targetSeverities);

      expect(result.value).toBeUndefined();
      expect(result.warnings).toHaveLength(0);
    });
  });

  describe('mapStatus', () => {
    const targetStatuses = new Map<string, IncidentStatus>([
      ['st1', { id: 'st1', name: 'Triage', category: 'triage', rank: 1 }],
      ['st2', { id: 'st2', name: 'Investigating', category: 'live', rank: 2 }],
      ['st3', { id: 'st3', name: 'Resolved', category: 'closed', rank: 3 }],
    ]);

    it('should map by exact name and category', () => {
      const source = { id: 'src1', name: 'Triage', category: 'triage' };
      const result = mapStatus(source, targetStatuses);

      expect(result.value).toBe('st1');
      expect(result.warnings).toHaveLength(0);
    });

    it('should map by name when category differs', () => {
      const source = { id: 'src1', name: 'Triage', category: 'other' };
      const result = mapStatus(source, targetStatuses);

      expect(result.value).toBe('st1');
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('category differs');
    });

    it('should fallback to category mapping', () => {
      const source = { id: 'src1', name: 'Unknown', category: 'live' };
      const result = mapStatus(source, targetStatuses);

      expect(result.value).toBe('st2');
      expect(result.warnings).toHaveLength(1);
    });

    it('should return no value when no mapping found', () => {
      const source = { id: 'src1', name: 'Unknown', category: 'unknown' };
      const result = mapStatus(source, targetStatuses);

      expect(result.value).toBeUndefined();
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('could not be mapped');
    });
  });

  describe('mapIncidentType', () => {
    const targetTypes = new Map<string, IncidentType>([
      ['type1', { id: 'type1', name: 'Service Outage' }],
      ['type2', { id: 'type2', name: 'Security Incident' }],
    ]);

    it('should map by exact name', () => {
      const source = { id: 'src1', name: 'Service Outage' };
      const result = mapIncidentType(source, targetTypes);

      expect(result.value).toBe('type1');
      expect(result.warnings).toHaveLength(0);
    });

    it('should map case-insensitively', () => {
      const source = { id: 'src1', name: 'service outage' };
      const result = mapIncidentType(source, targetTypes);

      expect(result.value).toBe('type1');
      expect(result.warnings).toHaveLength(0);
    });

    it('should warn when not found', () => {
      const source = { id: 'src1', name: 'Unknown Type' };
      const result = mapIncidentType(source, targetTypes);

      expect(result.value).toBeUndefined();
      expect(result.warnings).toHaveLength(1);
    });
  });

  describe('mapUser', () => {
    const targetUsers = new Map<string, User>([
      ['user1', { id: 'user1', email: 'alice@example.com', slack_user_id: 'U123' }],
      ['user2', { id: 'user2', email: 'bob@example.com', slack_user_id: 'U456' }],
    ]);

    it('should map by email', () => {
      const source = { id: 'src1', email: 'alice@example.com' };
      const result = mapUser(source, targetUsers);

      expect(result.value).toBe('user1');
      expect(result.warnings).toHaveLength(0);
    });

    it('should map by email case-insensitively', () => {
      const source = { id: 'src1', email: 'ALICE@EXAMPLE.COM' };
      const result = mapUser(source, targetUsers);

      expect(result.value).toBe('user1');
      expect(result.warnings).toHaveLength(0);
    });

    it('should fallback to slack_user_id', () => {
      const source = { id: 'src1', email: 'unknown@example.com', slack_user_id: 'U123' };
      const result = mapUser(source, targetUsers);

      expect(result.value).toBe('user1');
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('Slack ID');
    });

    it('should warn when user not found', () => {
      const source = { id: 'src1', email: 'unknown@example.com' };
      const result = mapUser(source, targetUsers);

      expect(result.value).toBeUndefined();
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('not found');
    });

    it('should handle undefined source', () => {
      const result = mapUser(undefined, targetUsers);

      expect(result.value).toBeUndefined();
      expect(result.warnings).toHaveLength(0);
    });
  });
});

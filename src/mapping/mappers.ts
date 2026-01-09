import type {
  Severity,
  IncidentStatus,
  IncidentType,
  CustomField,
  CustomFieldValue,
  IncidentTimestamp,
  IncidentTimestampValue,
  IncidentRole,
  IncidentRoleAssignment,
  User,
} from '../types.js';

export interface MappingResult<T> {
  value?: T;
  warnings: string[];
}

// Severity mapping: by name, fallback by rank
export function mapSeverity(
  sourceSeverity: { id: string; name: string; rank: number } | undefined,
  targetSeverities: Map<string, Severity>
): MappingResult<string> {
  if (!sourceSeverity) {
    return { warnings: [] };
  }

  // Try exact name match first
  for (const [id, severity] of targetSeverities) {
    if (severity.name.toLowerCase() === sourceSeverity.name.toLowerCase()) {
      return { value: id, warnings: [] };
    }
  }

  // Fallback: find by closest rank
  const sortedByRank = Array.from(targetSeverities.values()).sort((a, b) => a.rank - b.rank);
  const closest = sortedByRank.reduce((prev, curr) =>
    Math.abs(curr.rank - sourceSeverity.rank) < Math.abs(prev.rank - sourceSeverity.rank)
      ? curr
      : prev
  );

  return {
    value: closest.id,
    warnings: [
      `Severity "${sourceSeverity.name}" not found, mapped to "${closest.name}" by rank`,
    ],
  };
}

// Status mapping: by name and category
export function mapStatus(
  sourceStatus: { id: string; name: string; category: string } | undefined,
  targetStatuses: Map<string, IncidentStatus>
): MappingResult<string> {
  if (!sourceStatus) {
    return { warnings: [] };
  }

  // Try exact name match first
  for (const [id, status] of targetStatuses) {
    if (
      status.name.toLowerCase() === sourceStatus.name.toLowerCase() &&
      status.category === sourceStatus.category
    ) {
      return { value: id, warnings: [] };
    }
  }

  // Fallback: find by name only
  for (const [id, status] of targetStatuses) {
    if (status.name.toLowerCase() === sourceStatus.name.toLowerCase()) {
      return {
        value: id,
        warnings: [
          `Status "${sourceStatus.name}" found but category differs (source: ${sourceStatus.category}, target: ${status.category})`,
        ],
      };
    }
  }

  // Fallback: find any status with same category
  for (const [id, status] of targetStatuses) {
    if (status.category === sourceStatus.category) {
      return {
        value: id,
        warnings: [
          `Status "${sourceStatus.name}" not found, mapped to "${status.name}" by category`,
        ],
      };
    }
  }

  return {
    warnings: [`Status "${sourceStatus.name}" (${sourceStatus.category}) could not be mapped`],
  };
}

// Incident type mapping: by name
export function mapIncidentType(
  sourceType: { id: string; name: string } | undefined,
  targetTypes: Map<string, IncidentType>
): MappingResult<string> {
  if (!sourceType) {
    return { warnings: [] };
  }

  for (const [id, type] of targetTypes) {
    if (type.name.toLowerCase() === sourceType.name.toLowerCase()) {
      return { value: id, warnings: [] };
    }
  }

  return {
    warnings: [`Incident type "${sourceType.name}" not found in target`],
  };
}

// Timestamp mapping: by name
export function mapTimestamps(
  sourceTimestamps: IncidentTimestampValue[] | undefined,
  _targetTimestamps: Map<string, IncidentTimestamp>
): MappingResult<IncidentTimestampValue[]> {
  if (!sourceTimestamps || sourceTimestamps.length === 0) {
    return { value: [], warnings: [] };
  }

  const mapped: IncidentTimestampValue[] = [];
  const warnings: string[] = [];

  // Build reverse map of source timestamp IDs to their details
  // We'll need to look up by name, so we assume the source context has this info
  // For now, we'll use the timestamp value structure as-is

  for (const sourceTs of sourceTimestamps) {
    // We need the timestamp name from source - but we don't have it in the value
    // This is a limitation: we need to pass source timestamp definitions
    // For now, we'll just copy the value and warn that we can't map without names
    warnings.push(
      `Cannot map timestamp ID ${sourceTs.incident_timestamp_id} without name information`
    );
  }

  return { value: mapped, warnings };
}

// Better timestamp mapping with source context
export function mapTimestampsWithContext(
  sourceTimestamps: IncidentTimestampValue[] | undefined,
  sourceTimestampDefs: Map<string, IncidentTimestamp>,
  targetTimestamps: Map<string, IncidentTimestamp>
): MappingResult<IncidentTimestampValue[]> {
  if (!sourceTimestamps || sourceTimestamps.length === 0) {
    return { value: [], warnings: [] };
  }

  const mapped: IncidentTimestampValue[] = [];
  const warnings: string[] = [];

  for (const sourceTs of sourceTimestamps) {
    const sourceDef = sourceTimestampDefs.get(sourceTs.incident_timestamp_id);
    if (!sourceDef) {
      warnings.push(`Source timestamp ${sourceTs.incident_timestamp_id} definition not found`);
      continue;
    }

    let found = false;
    for (const [targetId, targetDef] of targetTimestamps) {
      if (targetDef.name.toLowerCase() === sourceDef.name.toLowerCase()) {
        mapped.push({
          incident_timestamp_id: targetId,
          value: sourceTs.value,
        });
        found = true;
        break;
      }
    }

    if (!found) {
      warnings.push(`Timestamp "${sourceDef.name}" not found in target`);
    }
  }

  return { value: mapped, warnings };
}

// User mapping: by email, fallback by slack_user_id
export function mapUser(
  sourceUser: { id: string; email?: string; slack_user_id?: string } | undefined,
  targetUsers: Map<string, User>
): MappingResult<string> {
  if (!sourceUser) {
    return { warnings: [] };
  }

  // Try email first
  if (sourceUser.email) {
    for (const [id, user] of targetUsers) {
      if (user.email.toLowerCase() === sourceUser.email.toLowerCase()) {
        return { value: id, warnings: [] };
      }
    }
  }

  // Fallback: slack_user_id
  if (sourceUser.slack_user_id) {
    for (const [id, user] of targetUsers) {
      if (user.slack_user_id === sourceUser.slack_user_id) {
        return {
          value: id,
          warnings: [`User mapped by Slack ID (email not matched)`],
        };
      }
    }
  }

  return {
    warnings: [
      `User ${sourceUser.email || sourceUser.id} not found in target (may need to invite them)`,
    ],
  };
}

// Role assignment mapping
export function mapRoleAssignments(
  sourceAssignments: IncidentRoleAssignment[] | undefined,
  sourceRoles: Map<string, IncidentRole>,
  targetRoles: Map<string, IncidentRole>,
  targetUsers: Map<string, User>
): MappingResult<IncidentRoleAssignment[]> {
  if (!sourceAssignments || sourceAssignments.length === 0) {
    return { value: [], warnings: [] };
  }

  const mapped: IncidentRoleAssignment[] = [];
  const warnings: string[] = [];

  for (const assignment of sourceAssignments) {
    const sourceRole = sourceRoles.get(assignment.incident_role_id);
    if (!sourceRole) {
      warnings.push(`Source role ${assignment.incident_role_id} definition not found`);
      continue;
    }

    // Find target role by name
    let targetRoleId: string | undefined;
    for (const [id, role] of targetRoles) {
      if (role.name.toLowerCase() === sourceRole.name.toLowerCase()) {
        targetRoleId = id;
        break;
      }
    }

    if (!targetRoleId) {
      warnings.push(`Role "${sourceRole.name}" not found in target`);
      continue;
    }

    // Map assignee
    if (assignment.assignee) {
      const userResult = mapUser(assignment.assignee, targetUsers);
      if (userResult.value) {
        mapped.push({
          incident_role_id: targetRoleId,
          assignee: { id: userResult.value },
        });
      } else {
        warnings.push(...userResult.warnings);
      }
    } else {
      // Role with no assignee
      mapped.push({
        incident_role_id: targetRoleId,
      });
    }
  }

  return { value: mapped, warnings };
}

// Custom field mapping
export function mapCustomFieldValues(
  sourceValues: CustomFieldValue[] | undefined,
  sourceFields: Map<string, CustomField>,
  targetFields: Map<string, CustomField>
): MappingResult<CustomFieldValue[]> {
  if (!sourceValues || sourceValues.length === 0) {
    return { value: [], warnings: [] };
  }

  const mapped: CustomFieldValue[] = [];
  const warnings: string[] = [];

  for (const sourceValue of sourceValues) {
    const sourceField = sourceFields.get(sourceValue.custom_field_id);
    if (!sourceField) {
      warnings.push(`Source custom field ${sourceValue.custom_field_id} definition not found`);
      continue;
    }

    // Find target field by name
    let targetField: CustomField | undefined;
    for (const field of targetFields.values()) {
      if (field.name.toLowerCase() === sourceField.name.toLowerCase()) {
        targetField = field;
        break;
      }
    }

    if (!targetField) {
      warnings.push(`Custom field "${sourceField.name}" not found in target`);
      continue;
    }

    // Map the value based on field type
    if (
      targetField.field_type === 'single_select' ||
      targetField.field_type === 'multi_select'
    ) {
      const mappedValue = mapSelectFieldValue(
        sourceValue.value,
        sourceField,
        targetField
      );
      if (mappedValue.value !== undefined) {
        mapped.push({
          custom_field_id: targetField.id,
          value: mappedValue.value,
        });
      }
      warnings.push(...mappedValue.warnings);
    } else {
      // text, link, numeric - copy as-is
      mapped.push({
        custom_field_id: targetField.id,
        value: sourceValue.value,
      });
    }
  }

  return { value: mapped, warnings };
}

function mapSelectFieldValue(
  sourceValue: string | string[] | undefined,
  sourceField: CustomField,
  targetField: CustomField
): MappingResult<string | string[]> {
  if (sourceValue === undefined) {
    return { warnings: [] };
  }

  const sourceOptions = sourceField.options || [];
  const targetOptions = targetField.options || [];

  if (Array.isArray(sourceValue)) {
    // multi_select
    const mapped: string[] = [];
    const warnings: string[] = [];

    for (const optionId of sourceValue) {
      const sourceOption = sourceOptions.find((o) => o.id === optionId);
      if (!sourceOption) {
        warnings.push(
          `Source option ${optionId} in field "${sourceField.name}" not found`
        );
        continue;
      }

      const targetOption = targetOptions.find(
        (o) => o.value.toLowerCase() === sourceOption.value.toLowerCase()
      );
      if (targetOption) {
        mapped.push(targetOption.id);
      } else {
        warnings.push(
          `Option "${sourceOption.value}" in field "${sourceField.name}" not found in target`
        );
      }
    }

    return { value: mapped, warnings };
  } else {
    // single_select
    const sourceOption = sourceOptions.find((o) => o.id === sourceValue);
    if (!sourceOption) {
      return {
        warnings: [
          `Source option ${sourceValue} in field "${sourceField.name}" not found`,
        ],
      };
    }

    const targetOption = targetOptions.find(
      (o) => o.value.toLowerCase() === sourceOption.value.toLowerCase()
    );
    if (targetOption) {
      return { value: targetOption.id, warnings: [] };
    }

    return {
      warnings: [
        `Option "${sourceOption.value}" in field "${sourceField.name}" not found in target`,
      ],
    };
  }
}

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
  CatalogEntry,
} from '../types.js';

export interface MappingResult<T> {
  value?: T;
  warnings: string[];
}

// severity mapping: by name, fallback by rank
export function mapSeverity(
  sourceSeverity: { id: string; name: string; rank: number } | undefined,
  targetSeverities: Map<string, Severity>
): MappingResult<string> {
  if (!sourceSeverity) {
    return { warnings: [] };
  }

  // try exact name match first
  for (const [id, severity] of targetSeverities) {
    if (severity.name.toLowerCase() === sourceSeverity.name.toLowerCase()) {
      return { value: id, warnings: [] };
    }
  }

  // fallback: find by closest rank
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

// status mapping: by name and category
export function mapStatus(
  sourceStatus: { id: string; name: string; category: string } | undefined,
  targetStatuses: Map<string, IncidentStatus>
): MappingResult<string> {
  if (!sourceStatus) {
    return { warnings: [] };
  }

  // try exact name match first
  for (const [id, status] of targetStatuses) {
    if (
      status.name.toLowerCase() === sourceStatus.name.toLowerCase() &&
      status.category === sourceStatus.category
    ) {
      return { value: id, warnings: [] };
    }
  }

  // fallback: find by name only
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

  // fallback: find any status with same category
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

// incident type mapping: by name
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

// timestamp mapping with source context or from export data
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
    // try to get source definition from export data first, then fall back to source context
    const sourceDef = sourceTs.incident_timestamp || sourceTimestampDefs.get(sourceTs.incident_timestamp_id);
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

// user mapping: by email, fallback by slack_user_id
export function mapUser(
  sourceUser: { id: string; email?: string; slack_user_id?: string } | undefined,
  targetUsers: Map<string, User>
): MappingResult<string> {
  if (!sourceUser) {
    return { warnings: [] };
  }

  // try email first
  if (sourceUser.email) {
    for (const [id, user] of targetUsers) {
      if (user.email.toLowerCase() === sourceUser.email.toLowerCase()) {
        return { value: id, warnings: [] };
      }
    }
  }

  // fallback: slack_user_id
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

// role assignment mapping
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
    // try to get source role from export data first, then fall back to source context
    const sourceRole = assignment.role || sourceRoles.get(assignment.incident_role_id);
    if (!sourceRole) {
      warnings.push(`Source role ${assignment.incident_role_id} definition not found`);
      continue;
    }

    // find target role by name
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

    // map assignee
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
      // role with no assignee
      mapped.push({
        incident_role_id: targetRoleId,
      });
    }
  }

  return { value: mapped, warnings };
}

// custom field mapping
export function mapCustomFieldValues(
  sourceValues: CustomFieldValue[] | undefined,
  sourceFields: Map<string, CustomField>,
  targetFields: Map<string, CustomField>,
  catalogEntries?: Map<string, CatalogEntry[]>
): MappingResult<CustomFieldValue[]> {
  if (!sourceValues || sourceValues.length === 0) {
    return { value: [], warnings: [] };
  }

  const mapped: CustomFieldValue[] = [];
  const warnings: string[] = [];

  for (const sourceValue of sourceValues) {
    // try to get source field from export data first, then fall back to source context
    const sourceField = sourceValue.custom_field || sourceFields.get(sourceValue.custom_field_id);
    if (!sourceField) {
      warnings.push(`Source custom field ${sourceValue.custom_field_id} definition not found`);
      continue;
    }

    // find target field by name (trim whitespace for comparison)
    let targetField: CustomField | undefined;
    for (const field of targetFields.values()) {
      if (field.name.trim().toLowerCase() === sourceField.name.trim().toLowerCase()) {
        targetField = field;
        break;
      }
    }

    if (!targetField) {
      warnings.push(`Custom field "${sourceField.name}" not found in target`);
      continue;
    }

    // map the value based on field type
    if (
      targetField.field_type === 'single_select' ||
      targetField.field_type === 'multi_select'
    ) {
      // get target catalog entries if this is a catalog-backed field
      const targetCatalogEntries = targetField.catalog_type_id && catalogEntries
        ? catalogEntries.get(targetField.catalog_type_id)
        : undefined;

      const mappedValue = mapSelectFieldValue(
        sourceValue.values,
        sourceField,
        targetField,
        targetCatalogEntries
      );
      if (mappedValue.value !== undefined && mappedValue.value.length > 0) {
        mapped.push({
          custom_field_id: targetField.id,
          values: mappedValue.value,
        });
      }
      warnings.push(...mappedValue.warnings);
    } else {
      // text, link, numeric - only include if there are actual values
      if (sourceValue.values && sourceValue.values.length > 0) {
        mapped.push({
          custom_field_id: targetField.id,
          values: sourceValue.values,
        });
      }
    }
  }

  return { value: mapped, warnings };
}

function mapSelectFieldValue(
  sourceValues: any[] | undefined,
  sourceField: CustomField,
  targetField: CustomField,
  targetCatalogEntries?: CatalogEntry[]
): MappingResult<any[]> {
  if (!sourceValues || sourceValues.length === 0) {
    return { value: [], warnings: [] };
  }

  const mapped: any[] = [];
  const warnings: string[] = [];

  for (const valueEntry of sourceValues) {
    // extract name from value_catalog_entry (catalog-backed) or value_option (standard options)
    const sourceName = valueEntry.value_catalog_entry?.name || valueEntry.value_option?.value;
    if (!sourceName) {
      warnings.push(`Value entry missing name in field "${sourceField.name}"`);
      continue;
    }

    // check if target is catalog-backed or options-backed
    if (targetCatalogEntries && targetCatalogEntries.length > 0) {
      // catalog-backed field - find matching catalog entry by name
      const targetEntry = targetCatalogEntries.find(
        (e) => e.name.toLowerCase() === sourceName.toLowerCase()
      );

      if (targetEntry) {
        mapped.push({
          value_catalog_entry_id: targetEntry.id
        });
      } else {
        warnings.push(
          `Catalog entry "${sourceName}" in field "${sourceField.name}" not found in target`
        );
      }
    } else if (targetField.options && targetField.options.length > 0) {
      // options-backed field - find matching option by name
      const targetOption = targetField.options.find(
        (o) => o.value.toLowerCase() === sourceName.toLowerCase()
      );

      if (targetOption) {
        mapped.push({
          value_link: targetOption.id
        });
      } else {
        warnings.push(
          `Option "${sourceName}" in field "${sourceField.name}" not found in target`
        );
      }
    } else {
      warnings.push(
        `Field "${sourceField.name}" has no options or catalog entries in target`
      );
    }
  }

  return { value: mapped, warnings };
}

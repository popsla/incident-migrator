import { createReadStream, createWriteStream } from 'fs';
import { readFile, rename } from 'fs/promises';
import { dirname, join } from 'path';
import { createInterface } from 'readline';
import { logger } from '../util/logging.js';

export interface PatchCustomFieldIdsOptions {
  incidentsFile: string;
  mappingCsvFile: string;
  outputFile?: string;
  inPlace?: boolean;
  removeCustomFieldsFile?: string;
  optionsPatchFile?: string;
}

type MappingLoadResult = {
  knownSourceIds: Set<string>;
  mapping: Map<string, string>; // only entries with non-empty target_id and non-ambiguous source_id
  ambiguousSourceIds: Set<string>;
  labelToSourceId: Map<string, string>;
  rows: number;
  rowsWithTarget: number;
};

function parseCsvLine(line: string): string[] {
  // Minimal CSV parser with quote support.
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        const next = line[i + 1];
        if (next === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else {
      if (ch === ',') {
        out.push(cur);
        cur = '';
      } else if (ch === '"') {
        inQuotes = true;
      } else {
        cur += ch;
      }
    }
  }
  out.push(cur);
  return out;
}

async function loadCustomFieldIdMapping(csvPath: string): Promise<MappingLoadResult> {
  const content = await readFile(csvPath, 'utf-8');
  const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) {
    return {
      knownSourceIds: new Set(),
      mapping: new Map(),
      ambiguousSourceIds: new Set(),
      labelToSourceId: new Map(),
      rows: 0,
      rowsWithTarget: 0,
    };
  }

  const header = parseCsvLine(lines[0]).map((h) => h.trim());
  const idxLabel = header.indexOf('label');
  const idxSource = header.indexOf('source_id');
  const idxTarget = header.indexOf('target_id');
  if (idxLabel === -1 || idxSource === -1 || idxTarget === -1) {
    throw new Error(`Invalid mapping CSV header. Expected columns: label,source_id,target_id`);
  }

  const knownSourceIds = new Set<string>();
  const mapping = new Map<string, string>();
  const ambiguousSourceIds = new Set<string>();
  const labelToSourceId = new Map<string, string>();

  let rows = 0;
  let rowsWithTarget = 0;

  for (let i = 1; i < lines.length; i++) {
    const row = parseCsvLine(lines[i]);
    const label = (row[idxLabel] || '').trim();
    const sourceId = (row[idxSource] || '').trim();
    const targetId = (row[idxTarget] || '').trim();

    if (!sourceId) continue;
    rows++;
    knownSourceIds.add(sourceId);
    if (label) {
      // Keep deterministic mapping if duplicates: pick lexicographically smallest sourceId.
      const key = label.toLowerCase();
      const existing = labelToSourceId.get(key);
      if (!existing || sourceId.localeCompare(existing) < 0) {
        labelToSourceId.set(key, sourceId);
      }
    }

    if (!targetId) {
      continue;
    }

    rowsWithTarget++;

    const existing = mapping.get(sourceId);
    if (existing && existing !== targetId) {
      // Conflicting mapping => mark ambiguous and remove mapping
      ambiguousSourceIds.add(sourceId);
      mapping.delete(sourceId);
      continue;
    }

    if (!ambiguousSourceIds.has(sourceId)) {
      mapping.set(sourceId, targetId);
    }
  }

  return { knownSourceIds, mapping, ambiguousSourceIds, labelToSourceId, rows, rowsWithTarget };
}

function isLikelyIncidentIoId(value: string): boolean {
  // incident.io IDs are ULID-like; we keep this loose but deterministic.
  return /^01[0-9A-Z]{10,}$/.test(value);
}

async function loadRemoveCustomFields(
  filePath: string,
  labelToSourceId: Map<string, string>
): Promise<{ removeIds: Set<string>; removeLabels: Set<string> }> {
  const content = await readFile(filePath, 'utf-8');
  const trimmed = content.trim();

  const removeIds = new Set<string>();
  const removeLabels = new Set<string>();

  const addToken = (raw: string) => {
    const t = raw.trim();
    if (!t) return;
    if (isLikelyIncidentIoId(t)) {
      removeIds.add(t);
      return;
    }
    const key = t.toLowerCase();
    removeLabels.add(key);
    const mappedId = labelToSourceId.get(key);
    if (mappedId) removeIds.add(mappedId);
  };

  // Support JSON array of strings OR newline-separated text.
  if (trimmed.startsWith('[')) {
    const arr = JSON.parse(trimmed) as unknown;
    if (!Array.isArray(arr)) {
      throw new Error(
        `--remove-custom-fields must be a JSON array of strings or a newline-separated file`
      );
    }
    for (const item of arr) {
      if (typeof item === 'string') addToken(item);
    }
    return { removeIds, removeLabels };
  }

  for (const line of content.split(/\r?\n/)) {
    addToken(line);
  }
  return { removeIds, removeLabels };
}

function normalizeOptionKey(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

async function loadOptionsPatchCsv(csvPath: string): Promise<{
  renameMap: Map<string, string>; // key: <field>\u0000<name> normalized
  rows: number;
  skippedEmptyNewName: number;
}> {
  const content = await readFile(csvPath, 'utf-8');
  const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return { renameMap: new Map(), rows: 0, skippedEmptyNewName: 0 };

  const header = parseCsvLine(lines[0]).map((h) => h.trim());
  const idxField = header.indexOf('field');
  const idxName = header.indexOf('name');
  const idxNewName = header.indexOf('new_name');
  if (idxField === -1 || idxName === -1 || idxNewName === -1) {
    throw new Error(`Invalid options patch CSV header. Expected columns: field,name,new_name`);
  }

  const renameMap = new Map<string, string>();
  let rows = 0;
  let skippedEmptyNewName = 0;

  for (let i = 1; i < lines.length; i++) {
    const row = parseCsvLine(lines[i]);
    const field = (row[idxField] || '').trim();
    const name = (row[idxName] || '').trim();
    const newName = (row[idxNewName] || '').trim();
    if (!field || !name) continue;
    rows++;
    if (!newName) {
      skippedEmptyNewName++;
      continue;
    }
    const key = `${normalizeOptionKey(field)}\u0000${normalizeOptionKey(name)}`;
    // Deterministic: if duplicates exist, keep lexicographically smallest newName
    const existing = renameMap.get(key);
    if (!existing || newName.localeCompare(existing) < 0) {
      renameMap.set(key, newName);
    }
  }

  return { renameMap, rows, skippedEmptyNewName };
}

type PatchStats = {
  replaced: number;
  skippedNoTarget: number; // present in CSV but target_id empty
  skippedNoMatch: number; // not present in CSV mapping table at all (or ambiguous)
  skippedAmbiguous: number; // present in CSV with conflicting target_id values
  removed: number; // number of custom field entries removed (if configured)
  renamedOptions: number; // number of option values renamed (if configured)
};

function patchValue(
  value: unknown,
  mapping: Map<string, string>,
  knownSourceIds: Set<string>,
  ambiguousSourceIds: Set<string>,
  removeIds: Set<string> | undefined,
  removeLabels: Set<string> | undefined,
  optionsRenameMap: Map<string, string> | undefined,
  ctx: { inCustomFieldContext: boolean; keyHint?: string }
): { value: unknown; stats: PatchStats } {
  const stats: PatchStats = {
    replaced: 0,
    skippedNoTarget: 0,
    skippedNoMatch: 0,
    skippedAmbiguous: 0,
    removed: 0,
    renamedOptions: 0,
  };

  const patchIdString = (id: string): string => {
    if (!isLikelyIncidentIoId(id)) return id;

    if (ambiguousSourceIds.has(id)) {
      stats.skippedAmbiguous++;
      return id;
    }

    if (mapping.has(id)) {
      const target = mapping.get(id);
      if (target) {
        stats.replaced++;
        return target;
      }
    }

    // Count skips only for IDs that look like IDs
    if (knownSourceIds.has(id)) {
      stats.skippedNoTarget++;
    } else {
      stats.skippedNoMatch++;
    }
    return id;
  };

  if (Array.isArray(value)) {
    const out = value.map((v) => {
      // Arrays under custom field context may be ID lists
      if (typeof v === 'string' && ctx.inCustomFieldContext) {
        return patchIdString(v);
      }
      const r = patchValue(
        v,
        mapping,
        knownSourceIds,
        ambiguousSourceIds,
        removeIds,
        removeLabels,
        optionsRenameMap,
        ctx
      );
      stats.replaced += r.stats.replaced;
      stats.skippedNoTarget += r.stats.skippedNoTarget;
      stats.skippedNoMatch += r.stats.skippedNoMatch;
      stats.skippedAmbiguous += r.stats.skippedAmbiguous;
      stats.removed += r.stats.removed;
      stats.renamedOptions += r.stats.renamedOptions;
      return r.value;
    });
    return { value: out, stats };
  }

  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};

    for (const [k, v] of Object.entries(obj)) {
      const keyLower = k.toLowerCase();
      const nextCtx = {
        inCustomFieldContext:
          ctx.inCustomFieldContext ||
          keyLower.includes('custom_field') ||
          keyLower === 'custom_fields' ||
          keyLower === 'custom_field_entries',
        keyHint: k,
      };

      // Removal: filter custom_field_entries/custom_field_values arrays by custom field id / name.
      if (
        (keyLower === 'custom_field_entries' || keyLower === 'custom_field_values') &&
        Array.isArray(v)
      ) {
        const filtered: unknown[] = [];
        for (const item of v) {
          if (item && typeof item === 'object') {
            const entry = item as Record<string, unknown>;
            const cfObj = entry['custom_field'] as { id?: unknown; name?: unknown } | undefined;
            const cfId =
              (typeof entry['custom_field_id'] === 'string'
                ? entry['custom_field_id']
                : undefined) ?? (typeof cfObj?.id === 'string' ? cfObj.id : undefined);
            const cfNameRaw = typeof cfObj?.name === 'string' ? cfObj.name : undefined;
            const cfName = cfNameRaw ? cfNameRaw.toLowerCase() : undefined;

            const shouldRemove =
              ((cfId && removeIds?.has(cfId)) || (cfName && removeLabels?.has(cfName))) &&
              (removeIds !== undefined || removeLabels !== undefined);

            if (shouldRemove) {
              stats.removed++;
              continue;
            }

            // Option renames: apply to values within this custom field entry (best-effort, deterministic)
            if (optionsRenameMap && cfNameRaw && Array.isArray(entry['values'])) {
              const fieldKey = normalizeOptionKey(cfNameRaw);
              const values = entry['values'] as unknown[];
              for (const ve of values) {
                if (!ve || typeof ve !== 'object') continue;
                const vobj = ve as Record<string, unknown>;

                const valueOption = vobj['value_option'] as Record<string, unknown> | undefined;
                if (valueOption && typeof valueOption['value'] === 'string') {
                  const oldName = valueOption['value'];
                  const key = `${fieldKey}\u0000${normalizeOptionKey(oldName)}`;
                  const newName = optionsRenameMap.get(key);
                  if (newName && newName !== oldName) {
                    valueOption['value'] = newName;
                    stats.renamedOptions++;
                  }
                }

                const valueCatalog = vobj['value_catalog_entry'] as Record<string, unknown> | undefined;
                if (valueCatalog && typeof valueCatalog['name'] === 'string') {
                  const oldName = valueCatalog['name'];
                  const key = `${fieldKey}\u0000${normalizeOptionKey(oldName)}`;
                  const newName = optionsRenameMap.get(key);
                  if (newName && newName !== oldName) {
                    valueCatalog['name'] = newName;
                    stats.renamedOptions++;
                  }
                }
              }
            }
          }
          filtered.push(item);
        }

        // Now recurse for ID replacement within remaining items
        const r = patchValue(
          filtered,
          mapping,
          knownSourceIds,
          ambiguousSourceIds,
          removeIds,
          removeLabels,
          optionsRenameMap,
          nextCtx
        );
        stats.replaced += r.stats.replaced;
        stats.skippedNoTarget += r.stats.skippedNoTarget;
        stats.skippedNoMatch += r.stats.skippedNoMatch;
        stats.skippedAmbiguous += r.stats.skippedAmbiguous;
        stats.removed += r.stats.removed;
        stats.renamedOptions += r.stats.renamedOptions;
        out[k] = r.value;
        continue;
      }

      // Patch common patterns deterministically:
      // - custom_field_id: "<id>"
      // - (inside custom_field object) id: "<id>"
      // - arrays of ids under custom_field* keys
      if (typeof v === 'string') {
        if (keyLower === 'custom_field_id') {
          out[k] = patchIdString(v);
          continue;
        }
        if (nextCtx.inCustomFieldContext && keyLower === 'id') {
          out[k] = patchIdString(v);
          continue;
        }
      }

      const r = patchValue(
        v,
        mapping,
        knownSourceIds,
        ambiguousSourceIds,
        removeIds,
        removeLabels,
        optionsRenameMap,
        nextCtx
      );
      stats.replaced += r.stats.replaced;
      stats.skippedNoTarget += r.stats.skippedNoTarget;
      stats.skippedNoMatch += r.stats.skippedNoMatch;
      stats.skippedAmbiguous += r.stats.skippedAmbiguous;
      stats.removed += r.stats.removed;
      stats.renamedOptions += r.stats.renamedOptions;
      out[k] = r.value;
    }

    return { value: out, stats };
  }

  return { value, stats };
}

export async function patchCustomFieldIds(options: PatchCustomFieldIdsOptions): Promise<void> {
  const { incidentsFile, mappingCsvFile } = options;
  const baseName = incidentsFile.split('/').pop() || 'incidents.jsonl';

  const outputFile = options.inPlace
    ? join(dirname(incidentsFile), `${baseName}.tmp.patched.jsonl`)
    : options.outputFile || join(dirname(incidentsFile), `${baseName}.patched.jsonl`);

  logger.info('Patching incidents custom field IDs...');
  logger.info(`Incidents: ${incidentsFile}`);
  logger.info(`Mapping: ${mappingCsvFile}`);
  logger.info(`Output: ${options.inPlace ? incidentsFile : outputFile}`);

  const { knownSourceIds, mapping, ambiguousSourceIds, labelToSourceId, rows, rowsWithTarget } =
    await loadCustomFieldIdMapping(mappingCsvFile);

  if (ambiguousSourceIds.size > 0) {
    logger.warn(
      `Found ${ambiguousSourceIds.size} ambiguous source_id mapping(s); these will be skipped`
    );
  }

  logger.info(`Loaded ${rows} mapping row(s) (${rowsWithTarget} with target_id)`);

  let removeIds: Set<string> | undefined;
  let removeLabels: Set<string> | undefined;
  if (options.removeCustomFieldsFile) {
    const loaded = await loadRemoveCustomFields(options.removeCustomFieldsFile, labelToSourceId);
    removeIds = loaded.removeIds;
    removeLabels = loaded.removeLabels;
    logger.info(
      `Remove list: ${options.removeCustomFieldsFile} (${removeIds.size} id(s), ${removeLabels.size} label(s))`
    );
  }

  let optionsRenameMap: Map<string, string> | undefined;
  if (options.optionsPatchFile) {
    const loaded = await loadOptionsPatchCsv(options.optionsPatchFile);
    optionsRenameMap = loaded.renameMap;
    logger.info(
      `Options patch: ${options.optionsPatchFile} (${loaded.rows} row(s), ${loaded.skippedEmptyNewName} missing new_name, ${optionsRenameMap.size} active rename(s))`
    );
  }

  const inputStream = createReadStream(incidentsFile, { encoding: 'utf-8' });
  const rl = createInterface({ input: inputStream, crlfDelay: Infinity });
  const outStream = createWriteStream(outputFile, { encoding: 'utf-8' });

  let incidentsProcessed = 0;
  let replaced = 0;
  let skippedNoTarget = 0;
  let skippedNoMatch = 0;
  let skippedAmbiguous = 0;
  let removedCustomFieldEntries = 0;
  let renamedOptions = 0;
  let lineNumber = 0;

  try {
    for await (const line of rl) {
      lineNumber++;
      if (!line.trim()) {
        outStream.write(line + '\n');
        continue;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (e) {
        throw new Error(`Failed to parse JSONL at line ${lineNumber}: ${(e as Error).message}`);
      }

      const r = patchValue(
        parsed,
        mapping,
        knownSourceIds,
        ambiguousSourceIds,
        removeIds,
        removeLabels,
        optionsRenameMap,
        { inCustomFieldContext: false }
      );
      removedCustomFieldEntries += r.stats.removed;
      renamedOptions += r.stats.renamedOptions;
      replaced += r.stats.replaced;
      skippedNoTarget += r.stats.skippedNoTarget;
      skippedNoMatch += r.stats.skippedNoMatch;
      skippedAmbiguous += r.stats.skippedAmbiguous;

      // Preserve original line only if we didn't change anything (no id replacements and no removals)
      if (r.stats.replaced === 0 && r.stats.removed === 0 && r.stats.renamedOptions === 0) {
        outStream.write(line + '\n');
      } else {
        outStream.write(JSON.stringify(r.value) + '\n');
      }

      incidentsProcessed++;
      if (incidentsProcessed % 100 === 0) {
        logger.info(`Processed ${incidentsProcessed} incident bundle(s)...`);
      }
    }
  } finally {
    await new Promise<void>((resolve) => {
      outStream.end(() => resolve());
    });
  }

  if (options.inPlace) {
    await rename(outputFile, incidentsFile);
  }

  logger.success('Patch complete');
  logger.info(`Incidents processed: ${incidentsProcessed}`);
  logger.info(`IDs replaced: ${replaced}`);
  logger.info(`IDs skipped (ambiguous mapping): ${skippedAmbiguous}`);
  logger.info(`IDs skipped (no target_id): ${skippedNoTarget}`);
  logger.info(`IDs skipped (no match): ${skippedNoMatch}`);
  if (options.removeCustomFieldsFile) {
    logger.info(`Custom field entries removed: ${removedCustomFieldEntries}`);
  }
  if (options.optionsPatchFile) {
    logger.info(`Option values renamed: ${renamedOptions}`);
  }
}

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
}

type MappingLoadResult = {
  knownSourceIds: Set<string>;
  mapping: Map<string, string>; // only entries with non-empty target_id and non-ambiguous source_id
  ambiguousSourceIds: Set<string>;
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
      rows: 0,
      rowsWithTarget: 0,
    };
  }

  const header = parseCsvLine(lines[0]).map((h) => h.trim());
  const idxSource = header.indexOf('source_id');
  const idxTarget = header.indexOf('target_id');
  if (idxSource === -1 || idxTarget === -1) {
    throw new Error(`Invalid mapping CSV header. Expected columns: label,source_id,target_id`);
  }

  const knownSourceIds = new Set<string>();
  const mapping = new Map<string, string>();
  const ambiguousSourceIds = new Set<string>();

  let rows = 0;
  let rowsWithTarget = 0;

  for (let i = 1; i < lines.length; i++) {
    const row = parseCsvLine(lines[i]);
    const sourceId = (row[idxSource] || '').trim();
    const targetId = (row[idxTarget] || '').trim();

    if (!sourceId) continue;
    rows++;
    knownSourceIds.add(sourceId);

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

  return { knownSourceIds, mapping, ambiguousSourceIds, rows, rowsWithTarget };
}

function isLikelyIncidentIoId(value: string): boolean {
  // incident.io IDs are ULID-like; we keep this loose but deterministic.
  return /^01[0-9A-Z]{10,}$/.test(value);
}

type PatchStats = {
  replaced: number;
  skippedNoTarget: number; // present in CSV but target_id empty
  skippedNoMatch: number; // not present in CSV mapping table at all (or ambiguous)
  skippedAmbiguous: number; // present in CSV with conflicting target_id values
};

function patchValue(
  value: unknown,
  mapping: Map<string, string>,
  knownSourceIds: Set<string>,
  ambiguousSourceIds: Set<string>,
  ctx: { inCustomFieldContext: boolean; keyHint?: string }
): { value: unknown; stats: PatchStats } {
  const stats: PatchStats = {
    replaced: 0,
    skippedNoTarget: 0,
    skippedNoMatch: 0,
    skippedAmbiguous: 0,
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
      const r = patchValue(v, mapping, knownSourceIds, ambiguousSourceIds, ctx);
      stats.replaced += r.stats.replaced;
      stats.skippedNoTarget += r.stats.skippedNoTarget;
      stats.skippedNoMatch += r.stats.skippedNoMatch;
      stats.skippedAmbiguous += r.stats.skippedAmbiguous;
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

      const r = patchValue(v, mapping, knownSourceIds, ambiguousSourceIds, nextCtx);
      stats.replaced += r.stats.replaced;
      stats.skippedNoTarget += r.stats.skippedNoTarget;
      stats.skippedNoMatch += r.stats.skippedNoMatch;
      stats.skippedAmbiguous += r.stats.skippedAmbiguous;
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

  const { knownSourceIds, mapping, ambiguousSourceIds, rows, rowsWithTarget } =
    await loadCustomFieldIdMapping(mappingCsvFile);

  if (ambiguousSourceIds.size > 0) {
    logger.warn(
      `Found ${ambiguousSourceIds.size} ambiguous source_id mapping(s); these will be skipped`
    );
  }

  logger.info(`Loaded ${rows} mapping row(s) (${rowsWithTarget} with target_id)`);

  const inputStream = createReadStream(incidentsFile, { encoding: 'utf-8' });
  const rl = createInterface({ input: inputStream, crlfDelay: Infinity });
  const outStream = createWriteStream(outputFile, { encoding: 'utf-8' });

  let incidentsProcessed = 0;
  let replaced = 0;
  let skippedNoTarget = 0;
  let skippedNoMatch = 0;
  let skippedAmbiguous = 0;
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

      const r = patchValue(parsed, mapping, knownSourceIds, ambiguousSourceIds, {
        inCustomFieldContext: false,
      });
      replaced += r.stats.replaced;
      skippedNoTarget += r.stats.skippedNoTarget;
      skippedNoMatch += r.stats.skippedNoMatch;
      skippedAmbiguous += r.stats.skippedAmbiguous;

      // Preserve original line if no replacements were made for this record
      if (r.stats.replaced === 0) {
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
}

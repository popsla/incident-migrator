import type { IncidentIoApiClient } from '../api/client.js';
import type { CustomField } from '../types.js';
import { paginateAll } from '../api/client.js';
import { logger } from '../util/logging.js';
import { writeText } from '../util/fs.js';

export interface GenerateCorrespondenceMatrixOptions {
  outputFile: string;
  pageSize?: number;
}

function normalizeLabelForMatch(label: string): string {
  return label.trim().toLowerCase();
}

function normalizeLabelForOutput(label: string): string {
  return label.trim();
}

function csvEscape(value: string): string {
  // RFC 4180-ish: quote if contains comma, quote, CR/LF
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function sortById<T extends { id: string }>(a: T, b: T): number {
  return a.id.localeCompare(b.id);
}

export function buildCustomFieldLabelIndex(fields: CustomField[]): Map<string, CustomField[]> {
  const index = new Map<string, CustomField[]>();
  for (const f of fields) {
    const key = normalizeLabelForMatch(f.name);
    const existing = index.get(key) || [];
    existing.push(f);
    index.set(key, existing);
  }
  // Ensure deterministic selection order for ambiguous duplicates
  for (const [k, list] of index.entries()) {
    list.sort(sortById);
    index.set(k, list);
  }
  return index;
}

export async function generateCorrespondenceMatrix(
  sourceClient: IncidentIoApiClient,
  targetClient: IncidentIoApiClient,
  options: GenerateCorrespondenceMatrixOptions
): Promise<void> {
  const pageSize = options.pageSize ?? 100;
  const outputFile = options.outputFile;

  logger.info('Generating custom fields correspondence matrix...');

  const sourceFields: CustomField[] = [];
  for await (const field of paginateAll(
    (after) => sourceClient.listCustomFieldsV2({ page_size: pageSize, after }),
    (response) => response.custom_fields || []
  )) {
    sourceFields.push(field);
  }

  const targetFields: CustomField[] = [];
  for await (const field of paginateAll(
    (after) => targetClient.listCustomFieldsV2({ page_size: pageSize, after }),
    (response) => response.custom_fields || []
  )) {
    targetFields.push(field);
  }

  logger.info(`Loaded ${sourceFields.length} source custom field(s)`);
  logger.info(`Loaded ${targetFields.length} target custom field(s)`);

  const targetIndex = buildCustomFieldLabelIndex(targetFields);

  // Stable/deterministic row order
  const sortedSource = [...sourceFields].sort((a, b) => {
    const la = normalizeLabelForMatch(a.name);
    const lb = normalizeLabelForMatch(b.name);
    if (la !== lb) return la.localeCompare(lb);
    return a.id.localeCompare(b.id);
  });

  let matched = 0;
  let unmatched = 0;

  const lines: string[] = [];
  lines.push(['label', 'source_id', 'target_id'].join(','));

  for (const src of sortedSource) {
    const labelKey = normalizeLabelForMatch(src.name);
    const candidates = targetIndex.get(labelKey) || [];
    const targetId = candidates.length > 0 ? candidates[0].id : '';

    if (targetId) matched++;
    else unmatched++;

    const label = normalizeLabelForOutput(src.name);
    lines.push([csvEscape(label), csvEscape(src.id), csvEscape(targetId)].join(','));
  }

  await writeText(outputFile, lines.join('\n') + '\n');

  logger.success('Correspondence matrix generated');
  logger.info(`Output: ${outputFile}`);
  logger.info(`Matched: ${matched}`);
  logger.info(`Unmatched: ${unmatched}`);
}


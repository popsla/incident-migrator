import { readFile, writeFile, mkdir, access, stat } from 'fs/promises';
import { createReadStream } from 'fs';
import { createInterface } from 'readline';
import { dirname } from 'path';
import type { ExportManifest, ImportState, ImportReport } from '../types.js';

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function isDirectory(path: string): Promise<boolean> {
  try {
    const stats = await stat(path);
    return stats.isDirectory();
  } catch {
    return false;
  }
}

export async function writeJson(path: string, data: unknown): Promise<void> {
  await ensureDir(dirname(path));
  await writeFile(path, JSON.stringify(data, null, 2), 'utf-8');
}

export async function readJson<T>(path: string): Promise<T> {
  const content = await readFile(path, 'utf-8');
  return JSON.parse(content) as T;
}

export async function clearFile(path: string): Promise<void> {
  await ensureDir(dirname(path));
  await writeFile(path, '', 'utf-8');
}

export async function appendJsonl(path: string, data: unknown): Promise<void> {
  await ensureDir(dirname(path));
  const line = JSON.stringify(data) + '\n';
  await writeFile(path, line, { flag: 'a', encoding: 'utf-8' });
}

export async function* readJsonl<T>(path: string): AsyncGenerator<T> {
  const fileStream = createReadStream(path, { encoding: 'utf-8' });
  const rl = createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (line.trim()) {
      yield JSON.parse(line) as T;
    }
  }
}

export async function writeManifest(path: string, manifest: ExportManifest): Promise<void> {
  await writeJson(path, manifest);
}

export async function readManifest(path: string): Promise<ExportManifest> {
  return readJson<ExportManifest>(path);
}

export async function writeState(path: string, state: ImportState): Promise<void> {
  await writeJson(path, state);
}

export async function readState(path: string): Promise<ImportState | null> {
  if (!(await fileExists(path))) {
    return null;
  }
  return readJson<ImportState>(path);
}

export async function writeReport(path: string, report: ImportReport): Promise<void> {
  await writeJson(path, report);
}

export async function readReport(path: string): Promise<ImportReport> {
  return readJson<ImportReport>(path);
}

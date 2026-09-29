/**
 * exporters/index.js — the export registry.
 *
 * Every exporter is a plain object with the same shape:
 *   { id, label, description, mime, extension, build(records, settings) -> string }
 *
 * Adding Google Sheets sync in v2 means implementing that shape in
 * sheets.js and appending it to EXPORTERS. Nothing in the panel or the
 * background worker needs to change, because they only ever talk to this list.
 */

import { tsv, csv } from './tsv.js';
import { clientSummary } from './clientSummary.js';

export const EXPORTERS = [tsv, csv, clientSummary];

export function getExporter(id) {
  return EXPORTERS.find((e) => e.id === id) || null;
}

export { tsv, csv, clientSummary };

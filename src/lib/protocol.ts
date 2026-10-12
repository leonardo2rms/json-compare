import type { DiffResult } from './lineDiff';

export type ToolsRequest =
  | { id: number; type: 'format'; text: string; sortKeys: boolean }
  | { id: number; type: 'validate'; text: string };

export interface JsonError {
  message: string;
  line: number;
  column: number;
}

export type ToolsResponse =
  | { id: number; ok: true; text?: string }
  | { id: number; ok: false; error: JsonError };

/**
 * Each side is identified by a `key` (the editor model's version id). The text is
 * only sent when the worker does not already hold that exact version.
 */
export interface DiffSide {
  key: number;
  text?: string;
}

export type DiffRequest =
  | { id: number; type: 'diff'; a: DiffSide; b: DiffSide }
  | { id: number; type: 'reset' };

export type DiffResponse =
  | { id: number; ok: true; result?: DiffResult }
  | { id: number; ok: false; needText?: boolean; message: string };

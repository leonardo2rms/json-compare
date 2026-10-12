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

export interface DiffRequest {
  id: number;
  a: string;
  b: string;
}

export type DiffResponse =
  | { id: number; ok: true; result: DiffResult }
  | { id: number; ok: false; message: string };

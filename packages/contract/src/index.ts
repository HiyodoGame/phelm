import { z } from 'zod';

/**
 * Version of the phelm contract surface.
 * Kept in sync with the package version in package.json.
 */
export const PHELM_CONTRACT_VERSION = '0.0.1';

/**
 * Identifier of a task on the board, for example "T-0042".
 * Placeholder schema; replaced by the full contract in a later task.
 */
export const TaskIdSchema = z.string().regex(/^T-\d{4}$/);

export type TaskId = z.infer<typeof TaskIdSchema>;

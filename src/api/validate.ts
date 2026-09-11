/**
 * The one way request bodies and queries are read: through a zod schema.
 * A handler receives parsed, typed data or the request has already been
 * answered with a 400 that says which fields were wrong - never a coerced
 * guess at what the caller meant.
 */

import type { Request, Response } from "express";
import type { z } from "zod";
import { ValidationError } from "../store/businesses.ts";

export function parse<S extends z.ZodType>(
  schema: S,
  input: unknown,
  res: Response,
): z.infer<S> | undefined {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  res.status(400).json({
    error: "invalid_input",
    issues: result.error.issues.map((i) => ({ path: i.path.join("."), code: i.code, message: i.message })),
  });
  return undefined;
}

export const body = <S extends z.ZodType>(schema: S, req: Request, res: Response) =>
  parse(schema, req.body ?? {}, res);

export const query = <S extends z.ZodType>(schema: S, req: Request, res: Response) =>
  parse(schema, req.query, res);

/**
 * Store-layer validation errors become 400s with their message; anything
 * else is a real failure and must not be dressed up as the caller's fault.
 */
export function handleError(err: unknown, res: Response): void {
  if (err instanceof ValidationError) {
    res.status(400).json({ error: "invalid_input", message: err.message });
    return;
  }
  throw err;
}

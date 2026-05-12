import { z } from "zod";

export const authorIdSchema = z.uuid();

const authorFieldsSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
  })
  .strict();

export const createAuthorInputSchema = authorFieldsSchema.extend({
  id: authorIdSchema,
});

export const updateAuthorInputSchema = authorFieldsSchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, "At least one field must be provided");

export type CreateAuthorInput = z.infer<typeof createAuthorInputSchema>;
export type UpdateAuthorInput = z.infer<typeof updateAuthorInputSchema>;

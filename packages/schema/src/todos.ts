import { z } from "zod";

export const todoStatusSchema = z.enum(["todo", "in_progress", "done"]);
export const todoPrioritySchema = z.enum(["low", "medium", "high"]);

export const todoIdSchema = z.uuid();
const todoAuthorIdSchema = z.uuid();

const todoFieldsSchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    description: z.string().trim().max(4000).nullable().optional(),
    authorId: todoAuthorIdSchema,
    status: todoStatusSchema,
    priority: todoPrioritySchema,
  })
  .strict();

const createTodoFieldsSchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    description: z.string().trim().max(4000).nullable().optional(),
    authorId: todoAuthorIdSchema,
    status: todoStatusSchema.default("todo"),
    priority: todoPrioritySchema.default("medium"),
  })
  .strict();

export const createTodoInputSchema = createTodoFieldsSchema.extend({
  id: todoIdSchema,
});

export const updateTodoInputSchema = todoFieldsSchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, "At least one field must be provided");

export type CreateTodoInput = z.infer<typeof createTodoInputSchema>;
export type UpdateTodoInput = z.infer<typeof updateTodoInputSchema>;

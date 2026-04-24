import { z } from 'zod'

export const registerOpencodeSelfInputSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .refine(v => v.trim().length > 0, { message: 'name must not be empty' }),
    model: z.string().optional(),
    role: z.string().optional(),
    team: z.string().optional(),
    project_dir: z.string().min(1).optional(),
  })
  .strict()

export type RegisterOpencodeSelfInput = z.infer<typeof registerOpencodeSelfInputSchema>

export const DEFAULT_OPENCODE_SELF_MODEL = 'opencode'

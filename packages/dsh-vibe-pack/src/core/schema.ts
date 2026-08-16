import { z } from 'zod'

const id = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/i, 'must be a safe identifier')
const sha256 = z.string().regex(/^[a-f0-9]{64}$/i, 'must be a SHA-256 digest')

export const PackFileSchema = z.object({
  path: z.string().min(1),
  sha256,
  mode: z.enum(['create', 'replace', 'merge']).default('replace'),
  secret: z.literal(false).default(false),
}).strict()

export const PackSchemaV1 = z.object({
  schemaVersion: z.literal(1),
  id,
  version: z.string().min(1).max(128),
  compatibility: z.object({
    dsh: z.string().optional(),
    node: z.string().optional(),
  }).strict().default({}),
  files: z.array(PackFileSchema).min(1).max(10_000),
  ownership: z.record(id, z.array(z.string().min(1))).default({}),
  metadata: z.object({
    name: z.string().max(256).optional(),
    description: z.string().max(2_000).optional(),
    source: z.string().max(2_000).optional(),
  }).strict().default({}),
}).strict().superRefine((pack, ctx) => {
  const seen = new Set<string>()
  for (const file of pack.files) {
    if (seen.has(file.path)) ctx.addIssue({ code: 'custom', path: ['files'], message: `duplicate file path: ${file.path}` })
    seen.add(file.path)
  }
  const ownershipKeys = Object.keys(pack.ownership)
  if (ownershipKeys.some(owner => owner !== pack.id)) ctx.addIssue({ code: 'custom', path: ['ownership'], message: 'ownership may declare only the current pack id' })
  const declared = pack.ownership[pack.id]
  if (declared !== undefined) {
    const owned = new Set(declared)
    if (owned.size !== declared.length || owned.size !== seen.size || [...seen].some(path => !owned.has(path))) {
      ctx.addIssue({ code: 'custom', path: ['ownership', pack.id], message: 'ownership must list every manifest file exactly once' })
    }
  }
})

export type PackV1 = z.infer<typeof PackSchemaV1>
export type PackFile = z.infer<typeof PackFileSchema>
export const parsePackV1 = (value: unknown): PackV1 => PackSchemaV1.parse(value)

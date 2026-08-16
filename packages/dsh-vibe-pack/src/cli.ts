#!/usr/bin/env node
import { Command } from 'commander'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { PackManager } from './core/manager.js'
import type { SourceSpec } from './core/source.js'
const program = new Command().name('dsh-pack').description('Data-only DSH pack manager (never executes pack scripts)')
function manager(opts: { root: string }): PackManager { return new PackManager(opts.root) }
function source(value: string): SourceSpec { const normalized=value.toLowerCase(); return { kind: normalized.endsWith('.zip') || normalized.endsWith('.dshpack') ? 'archive' : 'directory', path: value } }
program.option('--root <path>', 'managed DSH root', dshHomePath())
program.command('inspect <source>').action(async (s) => { const result=await manager(program.opts()).inspect(source(s)); console.log(JSON.stringify({ pack: result.pack, sourceDigest: result.digest, files: [...result.files].map(([path,bytes])=>({path,bytes:bytes.byteLength})) }, null, 2)) })
program.command('plan <source>').action(async (s) => console.log(JSON.stringify(await manager(program.opts()).plan(source(s)), null, 2)))
program.command('install <source>').option('--force', 'permit declared conflicts').action(async (s, o) => console.log(JSON.stringify(await manager(program.opts()).install(source(s), o), null, 2)))
program.command('uninstall <id>').option('--force', 'remove locally modified owned resources').action(async (id, o) => { await manager(program.opts()).uninstall(id, o) })
program.command('history').action(async () => console.log(JSON.stringify(await manager(program.opts()).history(), null, 2)))
program.command('diff <id>').action(async id => console.log(JSON.stringify(await manager(program.opts()).diff(id), null, 2)))
program.command('export <id>').description('write .dshpack ZIP bytes to stdout').action(async id => { const encoded = await manager(program.opts()).export(id); process.stdout.write(Buffer.from(encoded.slice('dshpack/base64/v1:'.length), 'base64')) })
program.parseAsync().catch(error => { console.error(`dsh-pack: ${error.message}`); process.exitCode = 1 })

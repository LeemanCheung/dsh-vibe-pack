import { hostBundle } from '../../build/plugin-bundle.ts'
const config = hostBundle() as unknown as { entry: Record<string, string> }
config.entry = { index: 'src/index.ts', cli: 'src/cli.ts' }
export default config

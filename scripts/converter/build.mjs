import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
await build({absWorkingDir:fileURLToPath(new URL('.',import.meta.url)),entryPoints:['cli.js'],outfile:'converter.cjs',bundle:true,platform:'node',format:'cjs',target:'node20',legalComments:'linked',alias:{setimmediate:'./src/kindle-zip-scheduler.js',immediate:'./src/kindle-zip-scheduler.js'}});

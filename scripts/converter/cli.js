// GPL-3.0-only. Fixed local conversion entrypoint, no network or credentials.
import fs from 'node:fs';
import { convertKindleEpub } from './src/kindle-epub.js';
async function main() {
try {
  const [input,output]=process.argv.slice(2);
  if(!input||!output||process.argv.length!==4)throw Error('arguments');
  const before=fs.statSync(input);
  if(!before.isFile()||before.size<=0||before.size>64*1024*1024)throw Object.assign(Error(),{code:'conversion-size'});
  const result=await convertKindleEpub(fs.readFileSync(input));
  const after=fs.statSync(input);
  if(after.size!==before.size||after.mtimeMs!==before.mtimeMs||after.ino!==before.ino)throw Object.assign(Error(),{code:'changed'});
  fs.writeFileSync(output,result.bytes,{flag:'wx',mode:0o600});
  process.stdout.write(JSON.stringify({ok:true,bytes:result.bytes.length,engine:'embedded-azw3',stats:result.stats}));
} catch(e) { process.stdout.write(JSON.stringify({ok:false,code:['conversion-size','conversion-resource','changed'].includes(e.code)?e.code:'conversion'}));process.exitCode=1; }

}
main();

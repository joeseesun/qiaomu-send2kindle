// Independent-reader verification of the exact distributed converter CLI.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { JSDOM } from '../scripts/converter/node_modules/jsdom/lib/api.js';
import { MOBI } from '../scripts/converter/node_modules/foliate-js/mobi.js';
import { epubFixture } from './epub-fixture.mjs';
const cli=fileURLToPath(new URL('../scripts/converter/converter.cjs',import.meta.url));
const dom=new JSDOM();
Object.assign(globalThis,{document:dom.window.document,DOMParser:dom.window.DOMParser,XMLSerializer:dom.window.XMLSerializer});
globalThis.CSS={escape:value=>String(value).replace(/[^\w-]/g,c=>`\\${c}`)};
const flatten=items=>items.flatMap(item=>[item,...flatten(item.subitems||[])]);
async function convert(source,check){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'kindle-cli-test-'));
 try {
  const input=path.join(dir,'中文书.epub'),output=path.join(dir,'中文书.azw3');await fs.writeFile(input,source);
  // No external converter executable can be resolved from this process.
  const result=spawnSync(process.execPath,[cli,input,output],{env:{...process.env,PATH:''},encoding:'utf8',timeout:30000});
  await check(result,output);assert.deepEqual(new Uint8Array(await fs.readFile(input)),source);
 } finally {await fs.rm(dir,{recursive:true,force:true});}
}
for(const ncx of [false,true]) test(`shipped CLI preserves Chinese, cover, footnotes and ${ncx?'NCX':'nested EPUB3 TOC'}`,async()=>{
 await convert(await epubFixture({ncx}),async(result,output)=>{
  assert.equal(result.status,0,result.stderr);const receipt=JSON.parse(result.stdout);assert.equal(receipt.ok,true);
  const book=await new MOBI({}).open(new Blob([await fs.readFile(output)]));
  try {
   assert.equal(book.metadata.title,'中文测试书 & English');assert.deepEqual(book.metadata.author,['测试作者']);
   assert.equal(book.sections.length,2);const nav=flatten(book.toc);assert.deepEqual(nav.map(n=>n.label),['第一章','第二节','注释']);assert.notEqual(nav[0].href,nav[1].href);
   const doc=await book.sections[0].createDocument();assert.equal(doc.querySelector('#start')?.textContent,'第一章：中文开头');
   assert.equal(doc.body.textContent.match(/道可道/g).length,900);assert.ok(doc.body.textContent.includes('𠀀'));assert.ok(!doc.querySelector('script'));
   assert.match(doc.querySelector('img').getAttribute('src'),/^kindle:embed:/);
   const [noteIndex]=book.splitTOCHref(doc.querySelector('a').getAttribute('href'));assert.equal(noteIndex,1);
   assert.equal((await (await book.getCover()).arrayBuffer()).byteLength,68);
   assert.ok((await book.sections[1].createDocument()).body.textContent.includes('脚注正文'));
  } finally {book.destroy();}
 });
});
test('malformed, encrypted and unresolved-resource inputs fail without output',async()=>{
 for(const source of [new Uint8Array([1,2,3]),await epubFixture({encrypted:true}),await epubFixture({badResource:true}),await epubFixture({badLink:true})]) {
  await convert(source,async(result,output)=>{assert.notEqual(result.status,0);assert.equal(JSON.parse(result.stdout).ok,false);await assert.rejects(fs.stat(output));});
 }
});

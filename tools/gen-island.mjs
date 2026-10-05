// Keep the designer's supplied source intact; package only its component, never the demo harness.
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
const source=readFileSync(join(root,'docs/island/island.html'),'utf8');
const css=source.match(/<style>([\s\S]*?)\/\* ---------- Demo harness/)?.[1];
const js=source.match(/<script>([\s\S]*?)<\/script>/)?.[1];
if(!css || !js?.includes('function renderIsland')) throw Error('Island reference component not found');
const assets=join(root,'android/app/src/main/assets/ash-island');
mkdirSync(join(assets,'avatars'),{recursive:true});
writeFileSync(join(assets,'component.css'),'/* Generated from docs/island/island.html. */\n'+css.trimEnd()+'\n');
writeFileSync(join(assets,'component.js'),'// Generated from docs/island/island.html.\n'+js.trimEnd()+'\n');
for(const face of ['default','focused','listening','resting','success','thinking'])
  copyFileSync(join(root,`docs/island/avatars/${face}.webp`),join(assets,`avatars/${face}.webp`));

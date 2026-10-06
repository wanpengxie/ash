// The designer's reference (docs/island) stays the source: the avatars and tokens the native island draws with.
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
const assets=join(root,'android/app/src/main/assets/ash-island');
mkdirSync(join(assets,'avatars'),{recursive:true});
for(const face of ['default','focused','listening','resting','success','thinking'])
  copyFileSync(join(root,`docs/island/avatars/${face}.webp`),join(assets,`avatars/${face}.webp`));

// The native island reads the designer's tokens as Kotlin constants: one source for sizes, colours, type and motion.
const tokens=JSON.parse(readFileSync(join(root,'docs/island/island-tokens.json'),'utf8'));
const name=path=>path.map(p=>String(p).replace(/([a-z0-9])([A-Z])/g,'$1_$2').toUpperCase()).join('_');
const num=n=>Number.isInteger(n)?`${n}f`:`${n}f`;
const colour=text=>{
  const hex=/^#([0-9a-f]{6})$/i.exec(text); if(hex) return `0xFF${hex[1].toUpperCase()}.toInt()`;
  const rgba=/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+))?\s*\)$/i.exec(text);
  if(!rgba) return null;
  const [r,g,b]=rgba.slice(1,4).map(Number), a=Math.round(255*(rgba[4]===undefined?1:Number(rgba[4])));
  return `0x${[a,r,g,b].map(v=>v.toString(16).padStart(2,'0')).join('').toUpperCase()}.toInt()`;
};
const lines=[];
const walk=(value,path)=>{
  const key=name(path);
  if(path[0]==='shadow'&&path[1]==='css') {
    // "x y blur rgba(..)" layers -> floatArrayOf(x, y, blur) and their colours.
    const layers=value.split(/,(?![^(]*\))/).map(s=>s.trim().match(/^(-?[\d.]+)(?:px)?\s+(-?[\d.]+)(?:px)?\s+([\d.]+)(?:px)?\s+(.+)$/));
    lines.push(`    val SHADOW_LAYERS = arrayOf(${layers.map(m=>`floatArrayOf(${num(+m[1])}, ${num(+m[2])}, ${num(+m[3])})`).join(', ')})`);
    lines.push(`    val SHADOW_COLORS = intArrayOf(${layers.map(m=>colour(m[4])).join(', ')})`);
    return;
  }
  if(typeof value==='number') { lines.push(`    const val ${key} = ${path.at(-1).endsWith('Ms')?`${value}L`:num(value)}`); return; }
  if(typeof value==='boolean') { lines.push(`    const val ${key} = ${value}`); return; }
  if(Array.isArray(value)) { lines.push(`    val ${key} = floatArrayOf(${value.map(num).join(', ')})`); return; }
  if(typeof value==='string') {
    const c=colour(value); if(c) { lines.push(`    const val ${key} = ${c}`); return; }
    const bezier=/^cubic-bezier\(([^)]+)\)$/.exec(value);
    if(bezier) { lines.push(`    val ${key} = floatArrayOf(${bezier[1].split(',').map(v=>num(+v)).join(', ')})`); return; }
    if(path.at(-2)==='faceByKind') return;
    return; // notes, families, units, paths
  }
  if(path.at(-1)==='faceByKind') { lines.push(`    val ${key} = mapOf(${Object.entries(value).map(([k,v])=>`"${k}" to "${v}"`).join(', ')})`); return; }
  for(const [k,v] of Object.entries(value)) walk(v,[...path,k]);
};
for(const [k,v] of Object.entries(tokens)) walk(v,[k]);
const kotlin=`// Generated from docs/island/island-tokens.json by tools/gen-island.mjs. Do not edit; change the tokens.
package ai.ash.ui.island

/** The designer's island tokens, in dp, ms and ARGB. */
internal object IslandTokens {
${lines.join('\n')}
}
`;
mkdirSync(join(root,'android/app/src/main/java/ai/ash/ui/island'),{recursive:true});
writeFileSync(join(root,'android/app/src/main/java/ai/ash/ui/island/IslandTokens.kt'),kotlin);

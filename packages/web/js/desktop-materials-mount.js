import {createDesktopMaterials} from './desktop-materials.js';
import {createDesktopMaterialsPort} from './desktop-materials-port.js';

/** The normal shell's material entry owns one current screen-bound controller. */
export function mountDesktopMaterials({document,net,picker=null}) {
 const panel=document.querySelector('#desktopMaterials'),body=document.querySelector('#desktopMaterialsBody'),openButton=document.querySelector('#desktopMaterialsOpen'),closeButton=document.querySelector('#desktopMaterialsClose');
 if(!panel||!body||!openButton||!closeButton)throw new Error('Missing material entry');
 let current=null,epoch=0,destroyed=false;
 const close=()=>{epoch++;current?.close();current=null;panel.hidden=true;};
 const open=async(work=null)=>{if(destroyed)return;close();const born=epoch;panel.hidden=false;const ui=createDesktopMaterials({root:body,port:createDesktopMaterialsPort(net,{picker})});current=ui;try{await ui.open(work?{target:work}:{});}catch{if(!destroyed&&current===ui&&epoch===born&&!panel.hidden)body.textContent='暂时无法确认材料授权或连接，请重新打开核实';}};
 const click=()=>void open();openButton.addEventListener('click',click);closeButton.addEventListener('click',close);document.defaultView.addEventListener('pagehide',close);
 return Object.freeze({open,close,destroy(){if(destroyed)return;destroyed=true;close();openButton.removeEventListener('click',click);closeButton.removeEventListener('click',close);document.defaultView.removeEventListener('pagehide',close);}});
}

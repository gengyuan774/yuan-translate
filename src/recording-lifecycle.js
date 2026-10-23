// Hidden tabs keep recording. Only a document that is actually being destroyed
// releases its capture; a cached page can return and recover the same class.
export function initRecordingLifecycle({win=window,doc=document,active,persist,recover,exit}){
 let recovering=false;
 const restore=async()=>{if(!active()||recovering)return;recovering=true;try{await recover();}finally{recovering=false;}};
 const visible=()=>{if(doc.visibilityState==='hidden'){if(active())void persist();}else void restore();};
 const hide=event=>{if(!active())return;void persist();if(!event.persisted)exit();};
 const show=event=>{if(event.persisted)void restore();};
 doc.addEventListener('visibilitychange',visible);win.addEventListener('pagehide',hide);win.addEventListener('pageshow',show);win.addEventListener('online',restore);
 return ()=>{doc.removeEventListener('visibilitychange',visible);win.removeEventListener('pagehide',hide);win.removeEventListener('pageshow',show);win.removeEventListener('online',restore);};
}

// Hidden tabs keep recording. Only a document that is actually being destroyed
// releases its capture; a cached page can return and recover the same class.
export function initRecordingLifecycle({win=window,doc=document,active,persist,recover,exit,freeze=()=>{},failed=()=>{}}){
 let recovering=false;
 const restore=async()=>{if(!active()||recovering)return;recovering=true;try{await recover();}catch(error){failed(error);}finally{recovering=false;}};
 const save=()=>{if(active())void Promise.resolve().then(persist).catch(failed);};
 const visible=()=>{if(doc.visibilityState==='hidden')save();else void restore();};
 const hide=event=>{if(!active())return;save();if(!event.persisted)exit();};
 const show=event=>{if(event.persisted)void restore();};
 const frozen=()=>{if(active()){save();void Promise.resolve().then(freeze).catch(failed);}};
 doc.addEventListener('visibilitychange',visible);doc.addEventListener('freeze',frozen);doc.addEventListener('resume',restore);win.addEventListener('pagehide',hide);win.addEventListener('pageshow',show);win.addEventListener('online',restore);
 return ()=>{doc.removeEventListener('visibilitychange',visible);doc.removeEventListener('freeze',frozen);doc.removeEventListener('resume',restore);win.removeEventListener('pagehide',hide);win.removeEventListener('pageshow',show);win.removeEventListener('online',restore);};
}

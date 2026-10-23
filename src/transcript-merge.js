// These are conservative text cues, not a claim of grammatical understanding.
// In particular, a recognizer-added full stop does not make a fragment complete.
export function needsContinuation(text){
 const clean=String(text).trim().replace(/[\s.,!?;:。！？；：，…"'”’）)]+$/u,'');
 if(!clean)return false;
 if(/\b(and|or|but|because|although|unless|whereas|whether|which|whose|that|if|when|while|with|without|of|for|to|from|in|on|at|by|as|than|the|a|an|is|are|was|were|be|been|being|has|have|had|can|could|would|should|will|must|not|such as|due to|according to|in terms of)$/iu.test(clean))return true;
 if(/(?:因为|由于|虽然|如果|假如|但是|然而|所以|因此|以及|或者|并且|包括|例如|也就是说|取决于|关于|为了|的|与|和|是)$/u.test(clean))return true;
 if(/^(?:thank you|thanks|yes|no|okay|ok|all right)$/iu.test(clean))return false;
 const words=clean.match(/[a-z]+(?:['’-][a-z]+)*/giu)||[];
 if(words.length){
  if(/[?？]["”’')）]*$/u.test(text.trim()))return false;
  if(/^(?:because|although|unless|if|when|while|whereas|which|why)\b/iu.test(clean)&&!/[,:;，：；]/u.test(clean))return true;
  if(/^(?:the (?:main |first |second )?reason|the fact that|one of|what we|the (?:main|first|second) point)\b/iu.test(clean)&&!/\b(?:is|are|was|were|means|depends)\b/iu.test(clean))return true;
  if(words.length<=5)return true;
 }
 return !/[.!?。！？]["”’')）]*$/u.test(text.trim());
}

export class TranscriptMerger{
 constructor({submit,remove,maxWait=6000,setTimer=(callback,ms)=>setTimeout(callback,ms),clearTimer=id=>clearTimeout(id)}){
  // Native browser timers require Window as their receiver, not this merger.
  this.submit=submit;this.remove=remove;this.maxWait=maxWait;this.setTimer=setTimer;this.clearTimer=clearTimer;this.row=null;this.timer=null;
 }
 add(row){
  if(!row.source.trim()){row.state='translated';return;}
  const prior=this.row,last=prior?.sourceParts.at(-1);
  if(prior&&(prior.sourceLanguage!==row.sourceLanguage||row.offset-last.offset>12000||prior.source.length+row.source.length>800))this.flush();
  const part={id:row.id,offset:row.offset,source:row.source,sourceLanguage:row.sourceLanguage,...(typeof row.audioProof==='string'?{audioProof:row.audioProof}:{})};
  if(this.row){
   this.row.sourceParts.push(part);this.row.source=this.row.sourceParts.map(p=>p.source).join(' ');this.remove(row);
  }else{
   this.row=row;row.sourceParts=[part];row.state='assembling';
   // Deadline is anchored to the first fragment; later fragments never extend it.
   this.timer=this.setTimer(()=>this.flush(),this.maxWait);
  }
  if(!needsContinuation(this.row.source))this.flush();
 }
 flush(){
  this.clearTimer(this.timer);this.timer=null;
  const row=this.row;this.row=null;if(row)this.submit(row);
 }
}

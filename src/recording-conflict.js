export function showRecordingConflict(container,availability,onTakeover){
 container.replaceChildren(document.createTextNode(availability.message));container.hidden=false;
 const button=document.createElement('button');button.type='button';button.className='recording-takeover';button.textContent='停止其他录音，在此设备继续';
 button.addEventListener('click',async()=>{if(button.disabled)return;button.disabled=true;try{await onTakeover(availability.recording.id);}catch(error){container.replaceChildren(document.createTextNode(error.message));}});
 container.append(document.createElement('br'),button);return button;
}

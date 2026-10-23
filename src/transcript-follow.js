export function initTranscriptFollow(container,checkbox,button){
 let following=checkbox.checked;
 const atBottom=()=>container.scrollHeight-container.scrollTop-container.clientHeight<=4;
 const update=()=>{button.hidden=checkbox.checked&&atBottom();};
 const jump=()=>{
  checkbox.checked=true;following=true;
  container.scrollTo({top:container.scrollHeight,behavior:'instant'});
  update();
 };
 container.addEventListener('scroll',()=>{following=checkbox.checked&&atBottom();update();},{passive:true});
 checkbox.addEventListener('change',()=>{following=checkbox.checked;if(following)jump();else update();});
 button.addEventListener('click',jump);
 // Keep following when a resize changes the visible height of the subtitles.
 if(typeof ResizeObserver!=='undefined')new ResizeObserver(()=>{
  if(following&&checkbox.checked)container.scrollTo({top:container.scrollHeight,behavior:'instant'});
  update();
 }).observe(container);
 update();
 return {
  mutate(change){
   const top=container.scrollTop,follow=following&&checkbox.checked;change();
   container.scrollTo({top:follow?container.scrollHeight:top,behavior:'instant'});update();
  },
  render(html){
   const top=container.scrollTop,follow=following&&checkbox.checked;
   container.innerHTML=html;
   container.scrollTo({top:follow?container.scrollHeight:top,behavior:'instant'});
   update();
  },
  reset(){following=checkbox.checked;update();}
 };
}

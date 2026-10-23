export const PROFILE_PAGES={
 overview:{path:'/profile',title:'个人中心',subtitle:'账号、会员与课堂历史。'},
 security:{path:'/profile/security',title:'账号安全',subtitle:'修改密码和管理已接入的恢复方式。'},
 data:{path:'/profile/data',title:'个人数据',subtitle:'导出个人数据，或注销账号并删除数据。'},
 preferences:{path:'/profile/preferences',title:'课堂偏好',subtitle:'设置翻译模式和专业，应用到之后的课堂。'}
};
export function profileRoute(path,search=''){
 const normalized=path.replace(/\/$/,'');
 const view=Object.keys(PROFILE_PAGES).find(key=>PROFILE_PAGES[key].path===normalized);
 if(view==='overview'&&new URLSearchParams(search).has('deleting'))return 'data';
 return view||null;
}
export const profilePath=view=>PROFILE_PAGES[view]?.path||PROFILE_PAGES.overview.path;
export function profileLoginDestination(search){
 const next=new URLSearchParams(search).get('next');
 return Object.hasOwn(PROFILE_PAGES,next)||['membership','orders'].includes(next)?next:'overview';
}

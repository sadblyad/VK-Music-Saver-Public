// Local opt-in experiment. No remote lists, tracking, header access or redirects.
export const AUDIO_AD_RULE_ID=15001;
export function audioAdRules(enabled){
  return enabled?[{id:AUDIO_AD_RULE_ID,priority:1,action:{type:'block'},condition:{
    regexFilter:'^https://r\\.mradx\\.net/audio/',
    initiatorDomains:['vk.ru','vk.com'],resourceTypes:['media']
  }}]:[];
}
export async function setAudioAdBlock(enabled,api=chrome){
  await api.declarativeNetRequest.updateDynamicRules({removeRuleIds:[AUDIO_AD_RULE_ID],addRules:audioAdRules(enabled)});
  await api.storage.local.set({audioAdBlockTest:enabled});
}

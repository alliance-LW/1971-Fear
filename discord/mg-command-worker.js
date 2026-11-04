// Cloudflare Worker: Discord /mg scheduled <date> <time>.
// Required Worker secrets: DISCORD_PUBLIC_KEY, GITHUB_TOKEN.
// Required Worker variables: DISCORD_GUILD_ID, MG_R4_ROLE_ID.
// Register a guild slash command named mg with a scheduled subcommand,
// string options date (YYYY-MM-DD) and time (HH:MM, server time).
const encoder = new TextEncoder();
function json(obj,status=200){return new Response(JSON.stringify(obj),{status,headers:{"content-type":"application/json"}})}
function reply(content,ephemeral=true){return json({type:4,data:{content,flags:ephemeral?64:0}})}
function bytes(hex){return Uint8Array.from(hex.match(/.{2}/g).map(x=>parseInt(x,16)))}
async function verify(req,body,key){
 const sig=req.headers.get("X-Signature-Ed25519"),ts=req.headers.get("X-Signature-Timestamp");
 if(!sig||!ts||!key||!/^([0-9a-f]{2}){64}$/i.test(sig))return false;
 try{
  const k=await crypto.subtle.importKey("raw",bytes(key),"Ed25519",false,["verify"]);
  return await crypto.subtle.verify("Ed25519",k,bytes(sig),encoder.encode(ts+body));
 }catch{return false}
}
export default {async fetch(req,env){
 if(req.method!=="POST")return new Response("Method not allowed",{status:405});
 const raw=await req.text();
 if(!await verify(req,raw,env.DISCORD_PUBLIC_KEY))return new Response("Invalid Discord signature",{status:401});
 let data;try{data=JSON.parse(raw)}catch{return new Response("Invalid JSON",{status:400})}
 if(data.type===1)return json({type:1});
 if(data.type!==2)return reply("Unsupported interaction.");
 if(data.guild_id!==env.DISCORD_GUILD_ID)return reply("This command is restricted to the FEAR server.");
 if(!data.member?.roles?.includes(env.MG_R4_ROLE_ID))return reply("Only Leadership can use MG commands.");
 if(data.data?.name!=="mg")return reply("Use /mg commands.");
 const command=data.data.options?.[0]?.name;
 if(["next","calendar","availability"].includes(command)){
  if(data.channel_id!==(env.MG_CHANNEL_ID||"1567409272097214594"))return reply("Use #mg-scheduling for this command.");
  try{
   const response=await fetch("https://api.github.com/repos/alliance-LW/1971-Fear/contents/config/mg-r4-schedule.json",{headers:{"Authorization":"Bearer "+env.GITHUB_TOKEN,"Accept":"application/vnd.github.raw+json","User-Agent":"FEAR-MG-Discord-Worker"}});
   if(!response.ok)return reply("Cannot read current scheduling configuration (HTTP "+response.status+").");
   const cfg=JSON.parse(await response.text());
   if(command==="calendar")return reply("**Known MG conflicts**\\n"+(cfg.recurring_events||[]).map(e=>e.name+": "+e.weekday+" "+e.start_server_time+" server time").concat((cfg.events||[]).map(e=>e.name+": "+e.start_utc+" UTC")).join("\\n")+"\\n**Unconfirmed:** "+(cfg.unconfirmed_events||[]).join(", "));
   if(command==="availability")return reply("**Entered availability windows**\\n"+((cfg.participation_windows||[]).map(w=>w.start_utc+" – "+w.end_utc+": "+w.expected_percent+"% estimated").join("\\n")||"No member availability estimates have been entered.")+"\\nUnknown attendance is not assumed.");
   const offset=Number(cfg.server_utc_offset_minutes)*60000,now=Date.now(),local=new Date(now+offset);
   const [h,m]=cfg.preferred_start_server_time.split(":").map(Number);
   let base=Date.UTC(local.getUTCFullYear(),local.getUTCMonth(),local.getUTCDate(),h,m)-offset;
   if(base<now+Number(cfg.lead_minutes)*60000)base+=86400000;
   const duration=Number(cfg.mg_duration_minutes)*60000,step=Number(cfg.candidate_step_minutes)*60000;
   const conflicts=(cfg.events||[]).map(e=>[Date.parse(e.start_utc)-Number(e.buffer_before_minutes||0)*60000,Date.parse(e.end_utc)+Number(e.buffer_after_minutes||0)*60000]);
   const days=["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
   for(let d=-1;d<=Number(cfg.search_days)+1;d++){
    const day=new Date(now+offset+d*86400000);
    for(const e of cfg.recurring_events||[]){
     if(days[day.getUTCDay()]!==e.weekday)continue;
     const [eh,em]=e.start_server_time.split(":").map(Number);
     const t=Date.UTC(day.getUTCFullYear(),day.getUTCMonth(),day.getUTCDate(),eh,em)-offset;
     conflicts.push([t-Number(e.buffer_before_minutes||0)*60000,t+(Number(e.duration_minutes)+Number(e.buffer_after_minutes||0))*60000]);
    }
   }
   const windows=(cfg.participation_windows||[]).map(w=>[Date.parse(w.start_utc),Date.parse(w.end_utc),Number(w.expected_percent)]);
   const policy=cfg.scheduling_policy||{},maxWait=Number(policy.max_wait_hours||12),candidates=[];
   for(let t=base;t<=base+maxWait*3600000;t+=step){
    if(conflicts.some(([a,b])=>t<b&&t+duration>a))continue;
    const estimates=windows.filter(([a,b])=>t>=a&&t+duration<=b).map(x=>x[2]);
    const pct=estimates.length?Math.max(...estimates):null;
    const hours=(t-base)/3600000;
    const score=Number(policy.earliest_weight??0.5)*Math.max(0,1-hours/maxWait)+Number(policy.participation_weight??0.35)*(pct===null?0:pct/100)+Number(policy.preferred_time_weight??0.15)*Math.max(0,1-hours/12);
    candidates.push({t,pct,score});
   }
   if(!candidates.length)return reply("No conflict-free candidates in the configured window. R4 review required.");
   const hasEstimates=candidates.some(c=>c.pct!==null);
   candidates.sort((a,b)=>hasEstimates?b.score-a.score||a.t-b.t:a.t-b.t);
   const lines=candidates.slice(0,3).map((c,i)=>(i+1)+". "+new Date(c.t+offset).toISOString().slice(0,16).replace("T"," ")+" server"+(c.pct===null?" (participation unknown)":" ("+c.pct+"% estimated)"));
   return reply("**Tentative MG recommendations**\\n"+lines.join("\\n")+"\\n"+(hasEstimates?"Balanced weights applied.":"No participation estimates; earliest conflict-free fallback.")+"\\nUnconfirmed conflicts: "+(cfg.unconfirmed_events||[]).join(", ")+"\\nR4 must verify cooldown and game events before confirming.");
  }catch{return reply("Unable to load MG settings. Check GitHub access and Worker deployment.");}
 }
 if(command!=="scheduled")return reply("Use /mg next, /mg calendar, /mg availability or /mg scheduled.");
 const opts=Object.fromEntries((data.data.options[0].options||[]).map(x=>[x.name,x.value]));
 const date=opts.date,time=opts.time;
 if(typeof date!=="string"||typeof time!=="string"||!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(date)||!/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(time))return reply("Use date YYYY-MM-DD and time HH:MM in server time.");
 const d=new Date(date+"T"+time+":00Z");
 if(Number.isNaN(d.valueOf())||d.toISOString().slice(0,10)!==date)return reply("Invalid date.");
 if(!env.GITHUB_TOKEN)return reply("GitHub integration not configured.");
 const res=await fetch("https://api.github.com/repos/alliance-LW/1971-Fear/dispatches",{
  method:"POST",headers:{"authorization":"Bearer "+env.GITHUB_TOKEN,"accept":"application/vnd.github+json","content-type":"application/json","user-agent":"FEAR-MG-Discord-Worker"},
  body:JSON.stringify({event_type:"mg_scheduled",client_payload:{server_date:date,server_time:time,submitted_by:data.member.user?.id||data.user?.id||"unknown"}})
 });
 if(res.status!==204)return reply("Could not record MG in GitHub (HTTP "+res.status+"). Please notify an administrator.");
 return reply("MG schedule submitted: **"+date+" "+time+" server time**. GitHub will record the expected end and first-reset alert. Check the workflow run to verify completion.");
}};
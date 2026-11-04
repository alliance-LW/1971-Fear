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
 if(!data.member?.roles?.includes(env.MG_R4_ROLE_ID))return reply("Only the Leadership role can record MG.");
 if(data.data?.name!=="mg"||data.data?.options?.[0]?.name!=="scheduled")return reply("Use /mg scheduled.");
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
const fs=require("fs"),crypto=require("crypto");
const roster=JSON.parse(fs.readFileSync("data/train-roster.json","utf8"));
const history=JSON.parse(fs.readFileSync("data/train-history.json","utf8"));
const overrides=JSON.parse(fs.readFileSync("data/train-overrides.json","utf8"));
const MIN_DONATIONS=30000;
const previous=history.weeks?.length?history.weeks[history.weeks.length-1]:null;
const prior=new Set([...(previous?.assigned?.conductor||[]),...(previous?.assigned?.vip||[])].map(String));
const unavailable=new Set((overrides.unavailable||[]).map(x=>typeof x==="string"?x:String(x.name||"")));
const audit=[];
const eligible=[];
for(const m of roster.members||[]){
 const reasons=[];
 if(Number(m.donations)<MIN_DONATIONS)reasons.push("Below 30,000 weekly Tech Donations");
 if(prior.has(m.name))reasons.push("Conductor/VIP assigned previous week");
 if(unavailable.has(m.name))reasons.push("Marked unavailable");
 if(reasons.length)audit.push({name:m.name,status:"INELIGIBLE",vs:Number(m.vs)||0,donations:Number(m.donations)||0,reasons});
 else eligible.push({...m,vs:Number(m.vs)||0,donations:Number(m.donations)||0});
}
if(eligible.length<8){console.error("Need at least 8 eligible members to create two primaries plus three alternates each.");process.exit(1)}
const maxVS=Math.max(...eligible.map(m=>m.vs),1),maxDon=Math.max(...eligible.map(m=>m.donations),1);
for(const m of eligible){
 m.vsNormalized=m.vs/maxVS*100;
 m.donationNormalized=m.donations/maxDon*100;
 m.randomScore=crypto.randomInt(0,10001)/100;
 m.finalScore=m.vsNormalized*.40+m.donationNormalized*.30+m.randomScore*.30;
 audit.push({name:m.name,status:"ELIGIBLE",vs:m.vs,donations:m.donations,vs_normalized:+m.vsNormalized.toFixed(2),donation_normalized:+m.donationNormalized.toFixed(2),random:+m.randomScore.toFixed(2),final:+m.finalScore.toFixed(2)});
}
eligible.sort((a,b)=>b.finalScore-a.finalScore);
const take=()=>eligible.shift().name;
const selections={conductor:{primary:take(),alternates:[take(),take(),take()]},vip:{primary:take(),alternates:[take(),take(),take()]}};
const out={schema_version:1,status:"PROPOSED",week:roster.week,generated_at:new Date().toISOString(),formula:{minimum_donations:MIN_DONATIONS,vs_weight:.40,donation_weight:.30,random_weight:.30,cooldown:"Anyone actually assigned Conductor or VIP in the previous week is excluded."},selections,audit};
fs.writeFileSync("data/train-results.json",JSON.stringify(out,null,2)+"\n");
console.log(JSON.stringify(selections,null,2));

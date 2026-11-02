const fs=require("fs");const L=fs.readFileSync("capture.log","utf8").trim().split("\n").map(l=>{try{return JSON.parse(l)}catch{return null}}).filter(Boolean);
const p=L.find(x=>x.m=="POST");const h={};for(const k in p.h)if(k!=="authorization")h[k]=String(p.h[k]).slice(0,80);console.log(JSON.stringify(h,null,1));
const f=fs.readdirSync(".").filter(n=>n.startsWith("capture-body")).map(n=>[n,fs.statSync(n).size]).filter(x=>x[1]>0)[0];const b=fs.readFileSync(f[0]);console.log("first bytes",b.slice(0,4).toString("hex"));
let j;try{j=JSON.parse(b.toString())}catch(e){console.log("not json");process.exit()}
console.log(Object.keys(j));console.log("input types",j.input.map(i=>i.type+"/"+(i.role||"")+"/"+(Array.isArray(i.content)?i.content.map(c=>c.type).join(","):typeof i.content)));
console.log("tools",j.tools.map(t=>t.type+":"+(t.name||"")).join(" "));console.log("instr len",(j.instructions||"").length,"include",j.include,"stream",j.stream,"store",j.store);

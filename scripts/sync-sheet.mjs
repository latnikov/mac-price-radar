const endpoint=process.env.SHEET_WEBHOOK;
if(!endpoint){console.log('SHEET_WEBHOOK is not set; nothing to sync.');process.exit(0)}
const data=await (await fetch(new URL('../data/cheapest.json',import.meta.url))).json();
const r=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)});
if(!r.ok) throw new Error(`Sheet sync failed: ${r.status} ${await r.text()}`);
console.log('Sheet sync completed');

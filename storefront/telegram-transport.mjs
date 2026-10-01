import {request,Agent} from 'node:https';
import {isIP} from 'node:net';

// Optional route to an operator-verified Telegram API IPv4. Hostname, SNI and
// certificate validation always remain api.telegram.org; no third-party proxy.
export function telegramTransport(env, fetchImpl = fetch) {
  const ipv4=String(env.STORE_TELEGRAM_API_IPV4||'');
  if (!ipv4 || fetchImpl!==fetch) return fetchImpl;
  if (isIP(ipv4)!==4) throw new Error('STORE_TELEGRAM_API_IPV4 must be IPv4');
  const agent=new Agent({keepAlive:true,maxSockets:4});
  return (url,options={})=>{
    const target=new URL(url);
    if(target.protocol!=='https:' || target.hostname!=='api.telegram.org' || target.port && target.port!=='443') return fetchImpl(url,options);
    return new Promise((resolve,reject)=>{
      const req=request(target,{method:options.method||'GET',headers:options.headers,agent,signal:options.signal,
        servername:'api.telegram.org',rejectUnauthorized:true,family:4,autoSelectFamily:false,
        lookup:(_hostname,settings,cb)=>settings?.all?cb(null,[{address:ipv4,family:4}]):cb(null,ipv4,4)},res=>{
        const chunks=[];let size=0;
        res.on('data',chunk=>{size+=chunk.length;if(size>8*1024*1024){res.destroy(new Error('Telegram response too large'));return;}chunks.push(chunk);});
        res.on('error',reject);res.on('end',()=>resolve(new Response(Buffer.concat(chunks),{status:res.statusCode,headers:Object.fromEntries(Object.entries(res.headers).filter(([,v])=>typeof v==='string'))})));
      });
      req.on('error',reject);req.end(options.body);
    });
  };
}

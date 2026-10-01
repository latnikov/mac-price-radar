import { createHmac, timingSafeEqual } from 'node:crypto';
import { fail } from './core.mjs';
export function telegramIngest(store, dataSync, secret) {
  return async(req,res)=>{
    const peer=req.socket.remoteAddress;
    if(req.headers['x-forwarded-for']||!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(peer)||!secret||secret.length<32)throw fail(404,'Не найдено.');
    const timestamp=String(req.headers['x-mb-timestamp']||''),nonce=String(req.headers['x-mb-nonce']||'');
    if(!/^\d{10,13}$/.test(timestamp)||Math.abs(store.now()-Number(timestamp))>60000||!/^[a-f0-9]{32}$/.test(nonce))throw fail(403,'Подпись недействительна.');
    if(!store.limit(`telegram:${peer}`,180,60000))throw fail(429,'Повторите позже.');
    let size=0;const chunks=[];
    for await(const chunk of req){size+=chunk.length;if(size>1024*1024)throw fail(413,'Слишком большой пакет.');chunks.push(chunk);}
    const bytes=Buffer.concat(chunks),expected=createHmac('sha256',secret).update(timestamp+'\n'+nonce+'\n').update(bytes).digest('hex');
    const supplied=String(req.headers['x-mb-signature']||'');
    if(supplied.length!==expected.length||!timingSafeEqual(Buffer.from(supplied),Buffer.from(expected)))throw fail(403,'Подпись недействительна.');

    let packet;try{packet=JSON.parse(bytes.toString('utf8'));}catch{throw fail(400,'Неверный пакет.');}
    store.tx(()=>{
      store.db.prepare('DELETE FROM signed_nonces WHERE expires<?').run(store.now());
      if(!store.db.prepare('INSERT OR IGNORE INTO signed_nonces VALUES(?,?)').run(nonce,store.now()+120000).changes)throw fail(409,'Пакет уже получен.');
      try{dataSync.ingestTelegram(packet);}catch{throw fail(400,'Пакет не прошёл проверку.');}
    });
    res.writeHead(200,{'Content-Type':'application/json'});res.end('{"ok":true}');
  };
}

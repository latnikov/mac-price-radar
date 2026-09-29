import { DatabaseSync, backup } from 'node:sqlite';
import { mkdir, cp, chmod } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
const source=process.env.STORE_DB||resolve('data/private/storefront/shop.sqlite');
const target=process.argv[2];
if(!target)throw new Error('Specify a new private backup directory');
await mkdir(target,{recursive:true,mode:0o700});
const db=new DatabaseSync(source,{readOnly:true});
try { await backup(db,resolve(target,'shop.sqlite')); await chmod(resolve(target,'shop.sqlite'),0o600); }
finally {db.close();}
await cp(process.env.STORE_MEDIA_DIR||resolve(dirname(source),'media'),resolve(target,'media'),{recursive:true});
console.log('Shop database and photos backed up. Store the backup off-server.');

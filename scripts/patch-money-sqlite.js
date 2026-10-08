'use strict';
// Server-only SQLite 3.53.2 source patch. Refuse version drift before writing.
// The Unix VFS must never spill a financial journal to an unreserved filesystem.
const fs=require('node:fs'),crypto=require('node:crypto');
const file=process.argv[2],before=fs.readFileSync(file,'utf8');
const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
if(hash(before)!=='60d2f39a3726cd6b9021da6f4e868608d66fbb6528a9f513dc8ffcc640493422')throw Error('Unreviewed SQLite source');
const start=before.indexOf('static const char *unixTempFileDir(void){'),end=before.indexOf('\n}\n',start)+3;
if(start<0||end<start)throw Error('Missing temp selector');
const fn=`static const char *unixTempFileDir(void){
  struct stat buf;
  const char *zDir = getenv("AUXILO_SQLITE_TMPDIR");
  if( zDir!=0 && zDir[0]=='/' && osStat(zDir, &buf)==0
      && S_ISDIR(buf.st_mode) && osAccess(zDir, 03)==0 ){
    return zDir;
  }
  return 0;
}`;
let after=before.slice(0,start)+fn+before.slice(end);
const marker='static const char * const sqlite3azCompileOpt[] = {\n';
if(after.split(marker).length!==2)throw Error('Missing compile options');
after=after.replace(marker,marker+'#if SQLITE_OS_UNIX\n  "AUXILO_STRICT_TEMP=1",\n#endif\n');
if(hash(after)!=='dcd0fcf647169cdcac0c9c9447de52eeeb909aa5b075adeaff32b7e2d5892ad3')throw Error('Unexpected patched SQLite source');
fs.writeFileSync(file,after);process.stdout.write(JSON.stringify({before:hash(before),after:hash(after),strictTemp:1})+'\n');

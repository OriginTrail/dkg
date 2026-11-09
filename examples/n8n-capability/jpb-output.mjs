import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { jpbReadSpec } from './profiles/jpb-read-policy.mjs';
const fail = message => Object.assign(new Error(message), { status: 409, code: 'JPB_OUTPUT_UNCONFIRMED' });
// Load once: the reviewed profile revision and every execution use the same script bytes.
export const remoteScripts = Object.freeze(Object.fromEntries(
  ['jpb-read.py', 'jpb-write.py', 'jpb-invoke-program.py'].map(name =>
    [name, (name === 'jpb-read.py' ? 'import base64,json\nREAD_SPEC=json.loads(base64.b64decode("'
      + Buffer.from(JSON.stringify(jpbReadSpec)).toString('base64') + '"))\n' : '')
      + readFileSync(new URL('./' + name, import.meta.url), 'utf8')]),
));
export function createRemote(scripts = remoteScripts, spawnProcess = spawn) {
  const pinned = Object.freeze({ ...scripts });
  const maxOutputBytes = 2 * 1024 * 1024;
  return function remote(payload, scriptName = 'jpb-write.py') {
    if (!Object.hasOwn(pinned, scriptName)) throw fail('Unknown JPB script.');
    const script = 'import base64,json\nPAYLOAD=json.loads(base64.b64decode("'+Buffer.from(JSON.stringify(payload)).toString('base64')+'"))\n'+pinned[scriptName];
    return new Promise((resolve,reject)=>{
      const p=spawnProcess('ssh',['-o','BatchMode=yes','-o','ConnectTimeout=8','adminuser@100.113.215.1','python3','-'],{stdio:['pipe','pipe','pipe']});
      const chunks=[];let size=0;
      const timer=setTimeout(()=>p.kill(),scriptName === 'jpb-invoke-program.py' ? 40000 : 14000);
      p.stdout.on('data',b=>{
        if(size>maxOutputBytes)return;
        size+=b.length;if(size>maxOutputBytes)p.kill();else chunks.push(b);
      });
      p.stderr.resume();p.on('error',()=>{clearTimeout(timer);reject(fail('JPB SSH connection unavailable.'));});
      p.on('close',code=>{
        clearTimeout(timer);
        if(size>maxOutputBytes)return reject(fail('JPB SSH response exceeds the 2 MiB limit.'));
        if(code!==0)return reject(fail(scriptName === 'jpb-invoke-program.py' ? 'JPB Program invocation is unconfirmed. Retry uses the same invocation identity; check its arguments, approval and remote execution.' : scriptName === 'jpb-read.py' ? 'JPB read unavailable or incomplete; no source rows were accepted.' : 'JPB write/readback is unconfirmed. Retry checks the same asset; it does not create another.'));
        // SSH chunks can split a UTF-8 character; decode only the complete bounded response.
        try{resolve(JSON.parse(Buffer.concat(chunks,size).toString('utf8')));}catch{reject(fail('Invalid JPB receipt.'));}
      });
      p.stdin.on('error',()=>{});p.stdin.end(script);
    });
  }
}
export const remote = createRemote();

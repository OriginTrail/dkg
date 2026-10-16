"""Read-only process witness; never signals, starts, or retries the daemon."""
import pathlib,json,subprocess,sys,time,datetime
arm=sys.argv[1]; root=pathlib.Path('.tmp/2963'); d=root/'evidence'/arm/'restart-regression'; d.mkdir(exist_ok=True)
start=json.loads((root/'evidence'/arm/'startup-process.json').read_text()); parent=start['parentPid']; old=start['daemonPids'][0]
now=lambda:datetime.datetime.now(datetime.timezone.utc).isoformat()
def processes():
 rows=[]
 for line in subprocess.check_output(['ps','-axo','pid=,ppid=,comm='],text=True).splitlines():
  parts=line.split(None,2)
  if len(parts)==3:
   pid,ppid=int(parts[0]),int(parts[1])
   if pid in [parent,old] or ppid==parent:rows.append({'pid':pid,'ppid':ppid,'executable':pathlib.Path(parts[2]).name})
 return rows
before={'observedAt':now(),'parentPid':parent,'originalDaemonPid':old,'processes':processes()}
assert any(x['pid']==old and x['ppid']==parent for x in before['processes'])
(d/'process-before.json').write_text(json.dumps(before,indent=2));(d/'process-watcher-ready.json').write_text(json.dumps({'at':now()}))
faultfile=root/f'{arm}-home'/'2963-fault-restart-recovery.json';deadline=time.time()+180
last=None
while time.time()<deadline:
 rows=processes()
 if rows!=last:
  with (d/'process-observations.jsonl').open('a') as f:f.write(json.dumps({'at':now(),'processes':rows})+'\n')
  last=rows
 if faultfile.exists():
  try:fault=json.loads(faultfile.read_text())
  except json.JSONDecodeError:time.sleep(.1);continue
  children=[x['pid'] for x in rows if x['ppid']==parent and x['pid']!=old]
  absent=not any(x['pid']==old for x in rows)
  if absent and children:
   result={'observedAt':now(),'faultAt':fault['firedAt'],'faultPid':fault['pid'],'originalDaemonPid':old,'oldDaemonAbsent':True,'sameSupervisorPid':parent,'supervisorAlive':any(x['pid']==parent for x in rows),'replacementDaemonPids':children,'restartMechanism':'existing foreground supervisor, no manual restart or HTTP replay','faultImplementationExitCode':86,'osExitStatusCaptured':False,'containerRunning':subprocess.check_output(['docker','inspect','--format','{{.State.Running}}',f'dkg-2963-blazegraph-{arm}'],text=True).strip()=='true'}
   (d/'process-restart-proof.json').write_text(json.dumps(result,indent=2));assert result['faultPid']==old and result['supervisorAlive'] and result['containerRunning'];print('Witnessed original process disappearance and automatic supervisor replacement.');sys.exit(0)
 time.sleep(.25)
raise RuntimeError('No witnessed process replacement within 180 seconds; evidence retained')

// Codex UserPromptSubmit / PostToolUse / Stop command hook. The local service
// owns graph writes so concurrent Codex processes cannot race entity creation.
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

if (process.env.DKG_CODEX_SURFACE === 'dkg') { process.stdout.write('{}'); process.exit(0); }
let raw = ''; for await (const chunk of process.stdin) { raw += chunk; if (raw.length > 4000000) process.exit(1); }
let payload;
try {
  const input = JSON.parse(raw);
  const config = JSON.parse(readFileSync(process.argv[2] || join(homedir(), '.dkg/codex/config.json'), 'utf8'));
  const stateDir = config.stateDir || join(config.dkgHome || join(homedir(), '.dkg'), 'codex');
  // Keep only stable, needed fields. Tool arguments, outputs, credentials and
  // raw reasoning never enter the graph trace through this hook.
  payload = { surface: 'native', session_id: input.session_id, turn_id: input.turn_id,
    hook_event_name: input.hook_event_name, prompt: input.prompt,
    last_assistant_message: input.last_assistant_message, tool_name: input.tool_name,
    tool_use_id: input.tool_use_id, tool_failed: input.tool_response?.isError === true };
  try {
    const token = readFileSync(join(stateDir, 'memory-hook.token'), 'utf8').trim();
    const response = await fetch(`http://127.0.0.1:${config.port || 9210}/api/codex/memory/hook`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(18000),
    });
    if (!response.ok) throw new Error('Memory service unavailable');
    process.stdout.write(JSON.stringify(await response.json()));
  } catch {
    let capture = false;
    try { capture = JSON.parse(readFileSync(join(stateDir, 'memory/settings.json'), 'utf8')).nativeCapture === true; } catch {}
    if (capture) {
      const dir = join(stateDir, 'memory/native-outbox'); mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(join(dir, `${Date.now()}-${randomUUID()}.json`), JSON.stringify(payload), { mode: 0o600 });
    }
    process.stdout.write(JSON.stringify(input.hook_event_name === 'PostToolUse' ? {} : {
      systemMessage: `DKG memory service unavailable.${capture ? ' Capture queued locally for retry.' : ''} This turn continues without automatic DKG recall.`,
    }));
  }
} catch { process.stdout.write(JSON.stringify({ systemMessage: 'DKG memory hook could not read its configuration.' })); }

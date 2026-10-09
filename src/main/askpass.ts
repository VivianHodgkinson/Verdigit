import { app } from 'electron'
import { chmodSync, existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Git and ssh ask for credentials by running the program in GIT_ASKPASS /
 * SSH_ASKPASS with the prompt as its argument and reading the answer from
 * stdout. We point both at a tiny script that runs Electron as plain Node and
 * relays the prompt over a local socket to this process, which shows a dialog.
 */

const CLIENT = `
const net = require('net');
const sock = net.connect(process.env.SC_ASKPASS_SOCK);
let buf = '';
sock.on('connect', () => sock.write(JSON.stringify({ prompt: process.argv[2] || '', background: process.env.SC_ASKPASS_BACKGROUND === '1' }) + '\\n'));
sock.on('data', (d) => (buf += d));
sock.on('end', () => {
  try {
    const r = JSON.parse(buf);
    if (r.value === null) process.exit(1);
    process.stdout.write(r.value + '\\n');
    process.exit(0);
  } catch { process.exit(1); }
});
sock.on('error', () => process.exit(1));
`

let server: Server | null = null
let socketPath = ''

export async function startAskPass(handler: (prompt: string, background: boolean) => Promise<string | null>): Promise<Record<string, string>> {
  const dir = join(app.getPath('userData'), 'askpass')
  mkdirSync(dir, { recursive: true })
  const clientJs = join(dir, 'askpass-client.js')
  writeFileSync(clientJs, CLIENT)

  // A #! script works everywhere: Git for Windows only runs askpass helpers
  // that are .exe files or start with a shebang (it ships its own sh).
  const script = join(dir, 'askpass.sh')
  const slash = (p: string): string => p.replace(/\\/g, '/')
  writeFileSync(script, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "${slash(process.execPath)}" "${slash(clientJs)}" "$@"\n`)
  if (process.platform === 'win32') {
    socketPath = `\\\\.\\pipe\\verdigit-askpass-${process.pid}`
  } else {
    chmodSync(script, 0o755)
    socketPath = join(tmpdir(), `verdigit-askpass-${process.pid}.sock`)
    if (existsSync(socketPath)) unlinkSync(socketPath)
  }

  server = createServer((conn) => {
    let buf = ''
    conn.on('data', async (d) => {
      buf += d.toString()
      const nl = buf.indexOf('\n')
      if (nl < 0) return
      let prompt = ''
      let background = false
      try {
        const req = JSON.parse(buf.slice(0, nl))
        prompt = req.prompt
        background = req.background === true
      } catch {
        // ignore malformed request
      }
      buf = ''
      const value = await handler(prompt, background).catch(() => null)
      conn.end(JSON.stringify({ value }))
    })
    conn.on('error', () => {})
  })
  await new Promise<void>((resolve) => server!.listen(socketPath, resolve))

  return {
    GIT_ASKPASS: script,
    SSH_ASKPASS: script,
    SSH_ASKPASS_REQUIRE: 'force',
    SC_ASKPASS_SOCK: socketPath
  }
}

export function stopAskPass(): void {
  server?.close()
  if (process.platform !== 'win32' && socketPath && existsSync(socketPath)) {
    try {
      unlinkSync(socketPath)
    } catch {
      // already gone
    }
  }
}

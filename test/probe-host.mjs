/**
 * Host-half probe for lib/index.js.
 *
 * Imports the real route module, mounts it on a fake Connection service, and
 * drives the resolve route with fake Session and workspace lookups. It proves
 * the route answers exactly the shapes the browser half parses, maps absent
 * coordinates onto 404s, and never touches the filesystem itself.
 */
import { readFile } from 'node:fs/promises'

const failures = []
const check = (name, ok, detail) => {
  console.log((ok ? 'ok   ' : 'FAIL ') + name + (ok || detail === undefined ? '' : '  → ' + detail))
  if (!ok) failures.push(name)
}

const module = await import('../lib/index.js')

check('exports inject list', Array.isArray(module.inject), JSON.stringify(module.inject))
check(
  'inject covers connection + sessionQuery + workspaceFiles + sandboxPolicy',
  ['connection', 'sessionQuery', 'workspaceFiles', 'sandboxPolicy'].every((name) => module.inject.includes(name)),
  JSON.stringify(module.inject),
)
check('exports apply', typeof module.apply === 'function')

// ---------------------------------------------------------------------------
// Fake services: one presented delivery, one workspace root.
// ---------------------------------------------------------------------------
const presented = {
  type: 'deliverables/presented',
  seq: 7,
  time: 0,
  data: {
    turn: 3,
    files: [
      { path: 'shots/final.png', description: 'final frame' },
      { path: 'notes.md', description: 'notes' },
    ],
  },
}

const events = new Map([['7', presented]])

const sessionQuery = {
  readEvent: async (request) => {
    const target = events.get(String(request.seq))
    if (target === undefined) {
      const error = new Error('no such event')
      error.code = 'SESSION_QUERY_EVENT_NOT_FOUND'
      throw error
    }
    return { session: { id: request.sessionId, cwd: 'C:\\work' }, target, events: [], startSeq: request.seq, endSeq: request.seq }
  },
}

const statCalls = []
const workspaceFiles = {
  stat: async (scope, filePath) => {
    statCalls.push({ scope, filePath })
    if (filePath === 'missing.png') {
      const error = new Error('no such file')
      error.code = 'workspace-file/not-found'
      throw error
    }
    return { absolutePath: `C:\\work\\${String(filePath).replaceAll('/', '\\')}`, version: 'v1' }
  },
}

const routes = []
const ctx = {
  connection: {
    fetch: {
      register: (route) => {
        routes.push(route)
        return () => {}
      },
    },
  },
  sessionQuery,
  workspaceFiles,
  sandboxPolicy: { workspaceRoot: 'D:\\fallback' },
}

module.apply(ctx)

check('registers exactly one route', routes.length === 1, String(routes.length))
const route = routes[0]
check('route path', route?.path === '/api/drag-out.resolve', route?.path)
check('route is GET only', Array.isArray(route?.methods) && route.methods.length === 1 && route.methods[0] === 'GET', JSON.stringify(route?.methods))
check('route buffers the body', route?.requestBody === 'buffered', route?.requestBody)

const origin = 'http://127.0.0.1:55062'
const call = (query) => route.fetch(new Request(origin + '/api/drag-out.resolve' + query, { method: 'GET' }))

// ---------------------------------------------------------------------------
// 1. A delivered file resolves to a Session-scoped draggable address.
// ---------------------------------------------------------------------------
const ok = await call('?sessionId=session-1&seq=7&index=0')
check('resolves 200', ok.status === 200, String(ok.status))
const payload = await ok.json()
check('payload has address', typeof payload.address === 'string')
check(
  'address is a Session resource',
  payload.address === 'dsh-resource://file/session/session-1/C%3A/work/shots/final.png',
  payload.address,
)
check('payload name is the base name', payload.name === 'final.png', payload.name)
check('payload media type', payload.mediaType === 'image/png', payload.mediaType)
check('lookup used the Session cwd', statCalls.at(-1)?.scope?.workspaceRoot === 'C:\\work', JSON.stringify(statCalls.at(-1)))
check('lookup asked for the presented path', statCalls.at(-1)?.filePath === 'shots/final.png', statCalls.at(-1)?.filePath)
check('no cache header on a file identity answer', ok.headers.get('cache-control') === 'no-store', ok.headers.get('cache-control'))

// ---------------------------------------------------------------------------
// 2. A second index in the same event resolves independently.
// ---------------------------------------------------------------------------
const second = await call('?sessionId=session-1&seq=7&index=1')
const secondPayload = await second.json()
check('second file name', secondPayload.name === 'notes.md', secondPayload.name)
check('second file media type', secondPayload.mediaType === 'text/markdown', secondPayload.mediaType)

// ---------------------------------------------------------------------------
// 3. Absent or malformed coordinates are refused before any lookup.
// ---------------------------------------------------------------------------
const before = statCalls.length
for (const [label, query] of [
  ['no coordinates', ''],
  ['no session', '?seq=7&index=0'],
  ['no seq', '?sessionId=session-1&index=0'],
  ['negative seq', '?sessionId=session-1&seq=-1&index=0'],
  ['non-numeric index', '?sessionId=session-1&seq=7&index=x'],
]) {
  const response = await call(query)
  check(`refuses ${label} with 400`, response.status === 400, String(response.status))
}
check('refusals never reached the workspace lookup', statCalls.length === before)

// ---------------------------------------------------------------------------
// 4. Missing events and missing files become 404s, not 500s.
// ---------------------------------------------------------------------------
const noEvent = await call('?sessionId=session-1&seq=99&index=0')
check('unknown event is 404', noEvent.status === 404, String(noEvent.status))

events.set('8', { ...presented, seq: 8, data: { files: [{ path: 'missing.png' }] } })
const noFile = await call('?sessionId=session-1&seq=8&index=0')
check('missing file is 404', noFile.status === 404, String(noFile.status))

events.set('9', { type: 'deliverables/summary', seq: 9, time: 0, data: { files: [] } })
const wrongType = await call('?sessionId=session-1&seq=9&index=0')
check('non-delivery event is 404', wrongType.status === 404, String(wrongType.status))

events.set('10', { type: 'deliverables/presented', seq: 10, time: 0, data: { files: [{ path: 'notes.md' }] } })
const outOfRange = await call('?sessionId=session-1&seq=10&index=4')
check('out-of-range index is 404', outOfRange.status === 404, String(outOfRange.status))

// ---------------------------------------------------------------------------
// 5. The module never imports workspace/fs hooks of its own.
// ---------------------------------------------------------------------------
const source = await readFile(new URL('../lib/index.js', import.meta.url), 'utf8')
check('host half declares no filesystem imports', !/^\s*import\s/mu.test(source))
check('host half never writes', !/writeFile|cpSync|renameSync|unlink/u.test(source))

console.log('')
if (failures.length > 0) {
  console.error('FAILED: ' + failures.join(', '))
  process.exit(1)
}
console.log('host route resolves presented files into Session-scoped drag addresses')

/**
 * Load-time probe for lib/client.js.
 *
 * Runs the bundle inside a fake DSH client shell (ModuleLoader seed table, a
 * minimal React, a listener-recording window) and drives full press → travel →
 * release gestures against fake desktop APIs. Deliberately shallow: it proves
 * the bundle loads, registers one well-formed slot entry, renders nothing in a
 * browser tab, and asks the shell for a Session-scoped resource — how the drag
 * feels has to be verified in the real desktop app.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const here = path.dirname(fileURLToPath(import.meta.url))
const source = readFileSync(path.join(here, '..', 'lib', 'client.js'), 'utf8')

const failures = []
const check = (name, ok, detail) => {
  console.log((ok ? 'ok   ' : 'FAIL ') + name + (ok || detail === undefined ? '' : '  → ' + detail))
  if (!ok) failures.push(name)
}

// ---------------------------------------------------------------------------
// Fake React: createElement plus a Component base, enough to mount the grip.
// ---------------------------------------------------------------------------
const React = {
  createElement: (type, props, ...children) => ({
    type,
    props: { ...(props ?? {}), children: children.length > 1 ? children : children[0] },
  }),
  Component: class {
    constructor(props) {
      this.props = props ?? {}
      this.state = {}
    }
    setState(next) {
      this.state = { ...this.state, ...(typeof next === 'function' ? next(this.state) : next) }
    }
  },
}

const listeners = new Map()
const addListener = (type, handler) => {
  if (!listeners.has(type)) listeners.set(type, new Set())
  listeners.get(type).add(handler)
}
const removeListener = (type, handler) => {
  listeners.get(type)?.delete(handler)
}
const dispatch = (type, event) => {
  for (const handler of [...(listeners.get(type) ?? [])]) handler(event)
}

const styleIds = new Set()
const document = {
  head: { appendChild: (node) => node?.id && styleIds.add(node.id) },
  documentElement: { appendChild: () => {} },
  getElementById: (id) => (styleIds.has(id) ? {} : null),
  createElement: () => ({ id: 'ddo-style', set textContent(v) {} }),
}

// ---------------------------------------------------------------------------
// Fake desktop shell: records prepare/start/release/cancel in call order.
// ---------------------------------------------------------------------------
const calls = []
const resolvePayload = {
  address: 'dsh-resource://file/session/session-1/C%3A/probe/shot.png',
  name: 'shot.png',
  mediaType: 'image/png',
}
const fileDrag = {
  prepare: (sourceFly, requestId) => {
    calls.push(['prepare', sourceFly, requestId])
    const tail = decodeURIComponent(sourceFly.address.split('/').slice(-1)[0])
    if (tail !== sourceFly.name) throw new Error('name must equal the file name: ' + tail + ' vs ' + sourceFly.name)
    return 'handle-1'
  },
  start: (handle) => {
    calls.push(['start', handle])
    return true
  },
  release: (handle) => {
    calls.push(['release', handle])
  },
  cancel: (requestId) => {
    calls.push(['cancel', requestId])
  },
}

const fetchCalls = []
const fetchImpl = async (url) => {
  fetchCalls.push(url)
  return { ok: true, status: 200, json: async () => resolvePayload }
}

const loaded = []
const loader = {
  load: ({ id, factory }) => {
    loaded.push({
      id,
      exports: factory((name) => {
        if (name === 'react') return React
        throw new Error('unexpected require: ' + name)
      }),
    })
  },
}

const sandbox = {
  console,
  setTimeout,
  clearTimeout,
  document,
  fetch: fetchImpl,
  URLSearchParams,
  crypto: { randomUUID: () => 'request-1' },
  __ModuleLoader__: loader,
}

// The bundle reaches the loader through `window`, exactly like the real client.
sandbox.window = {
  addEventListener: addListener,
  removeEventListener: removeListener,
  location: { protocol: 'dsh-app:', hostname: 'app', href: 'dsh-app://app/' },
  __ModuleLoader__: loader,
}
sandbox.globalThis = sandbox
vm.createContext(sandbox)

// ---------------------------------------------------------------------------
// 1. The bundle loads and registers exactly one slot entry.
// ---------------------------------------------------------------------------
vm.runInContext(source, sandbox, { filename: 'client.js' })

const entry = loaded[0]
check('loader called load() once', loaded.length === 1)
check('loader id is the package name', entry?.id === 'dsh-drag-out', entry?.id)
check('exports.apply is a function', typeof entry?.exports?.apply === 'function')
check(
  'exports.inject names slots + locale',
  Array.isArray(entry?.exports?.inject) && entry.exports.inject.includes('slots') && entry.exports.inject.includes('locale'),
  JSON.stringify(entry?.exports?.inject),
)

const registrations = []
const dictionaries = []
const ctx = {
  effect: (fn) => {
    const dispose = fn()
    return typeof dispose === 'function' ? dispose : () => {}
  },
  locale: { register: (ns, values) => dictionaries.push({ ns, values }) },
  slots: {
    inject: (name, load) => {
      const value = load()
      registrations.push({ name, value })
      return () => {}
    },
    register: (descriptor, component) => ({ descriptor, component }),
  },
}
entry.exports.apply(ctx)

check('registers one slot', registrations.length === 1, String(registrations.length))
check('slot is deliverables.file.actions', registrations[0]?.name === 'deliverables.file.actions', registrations[0]?.name)
const descriptor = registrations[0]?.value?.descriptor
check('slot id is drag-out', descriptor?.id === 'drag-out', descriptor?.id)
check('slot locale namespace', descriptor?.locale === 'dsh-drag-out', descriptor?.locale)
check(
  'dictionary registered for zh + en',
  dictionaries[0]?.ns === 'dsh-drag-out' && Boolean(dictionaries[0].values.zh) && Boolean(dictionaries[0].values.en),
  JSON.stringify(Object.keys(dictionaries[0]?.values ?? {})),
)

const DragOutAction = registrations[0]?.value?.component
check('component is a class', typeof DragOutAction === 'function')

const mount = (props) => {
  const instance = new DragOutAction(props)
  if (typeof instance.componentDidMount === 'function') instance.componentDidMount()
  return instance
}

// ---------------------------------------------------------------------------
// 2. A browser tab (no desktop shell) renders nothing.
// ---------------------------------------------------------------------------
const browser = mount({
  actionUrl: 'present/open?sessionId=session-1&seq=7&index=0',
  available: true,
  pending: false,
  t: (key) => key,
})
check('no grip without a desktop shell', browser.render() === null, String(browser.render()))

// ---------------------------------------------------------------------------
// 3. A desktop shell renders a grip, and one gesture reaches prepare + start.
// ---------------------------------------------------------------------------
sandbox.window.dshDesktop = { fileDrag }

const t = (key) => ({ label: '拖出', hint: '按住拖到微信', preparing: '准备中…', error: '拖出失败' })[key] ?? key
const actionUrl = 'present/open?sessionId=session-1&seq=7&index=0'
const action = mount({ actionUrl, available: true, pending: false, t })
const tree = action.render()

check('styles are injected once', styleIds.has('ddo-style'))
check('grip is a button', tree?.type === 'button', tree?.type)
check(
  'grip carries the drag class',
  typeof tree?.props?.className === 'string' && tree.props.className.includes('ddo-grip'),
  tree?.props?.className,
)
check('grip label is 拖出', JSON.stringify(tree).includes('拖出'))
check('grip is not natively draggable', tree?.props?.draggable === false)

let prevented = false
tree.props.onPointerDown({
  pointerType: 'mouse',
  button: 0,
  isPrimary: true,
  clientX: 10,
  clientY: 20,
  preventDefault: () => {
    prevented = true
  },
  stopPropagation: () => {},
})
check('press is prevented (no preview open)', prevented === true)

dispatch('pointermove', { clientX: 10, clientY: 22 })
check('a 2px wobble does not start a drag', calls.length === 0, JSON.stringify(calls))

dispatch('pointermove', { clientX: 10, clientY: 40 })
await new Promise((resolve) => setTimeout(resolve, 0))

check('one resolve request was made', fetchCalls.length === 1, JSON.stringify(fetchCalls))
check(
  'resolve hit the authenticated route',
  String(fetchCalls[0]).startsWith('/api/drag-out.resolve?sessionId=session-1&seq=7&index=0'),
  String(fetchCalls[0]),
)
const prepared = calls.find(([kind]) => kind === 'prepare')
check('prepare ran once', calls.filter(([kind]) => kind === 'prepare').length === 1)
check('prepare source kind is resource', prepared?.[1]?.kind === 'resource', JSON.stringify(prepared?.[1]))
check('prepare source carries the Session address', prepared?.[1]?.address === resolvePayload.address, prepared?.[1]?.address)
check('prepare source name matches the file', prepared?.[1]?.name === 'shot.png', prepared?.[1]?.name)
check('prepare source media type', prepared?.[1]?.mediaType === 'image/png', prepared?.[1]?.mediaType)
check('prepare got the request id', prepared?.[2] === 'request-1', String(prepared?.[2]))
const started = calls.find(([kind]) => kind === 'start')
check('start ran with the prepared handle', started?.[1] === 'handle-1', String(started?.[1]))
check('no stray release after a successful start', !calls.some(([kind]) => kind === 'release'), JSON.stringify(calls))

// ---------------------------------------------------------------------------
// 4. A press that never travels releases the warmed handle instead of leaking.
// ---------------------------------------------------------------------------
calls.length = 0
const idle = mount({ actionUrl: 'present/open?sessionId=session-1&seq=8&index=0', available: true, pending: false, t })
idle.render().props.onPointerDown({
  pointerType: 'mouse',
  button: 0,
  isPrimary: true,
  clientX: 5,
  clientY: 5,
  preventDefault: () => {},
  stopPropagation: () => {},
})
dispatch('pointerup', { clientX: 5, clientY: 5 })
await new Promise((resolve) => setTimeout(resolve, 0))
const kinds = calls.map(([kind]) => kind)
check('un-dragged press released or cancelled the handle', kinds.includes('release') || kinds.includes('cancel'), kinds.join(','))
check('un-dragged press never started a drag', !kinds.includes('start'), kinds.join(','))

// ---------------------------------------------------------------------------
// 5. An unavailable slot seat (no file for this index) renders nothing.
// ---------------------------------------------------------------------------
const unavailable = mount({ actionUrl, available: false, pending: false, t })
check('unavailable seat renders nothing', unavailable.render() === null, String(unavailable.render()))

console.log('')
if (failures.length > 0) {
  console.error('FAILED: ' + failures.join(', '))
  process.exit(1)
}
console.log('client bundle loads, registers, and drives both drag outcomes cleanly')

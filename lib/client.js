window.__ModuleLoader__.load({
  id: 'dsh-drag-out',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    /** The delivery card and the Host half share one route: coordinates in, an address out. */
    const NS = 'dsh-drag-out'
    const RESOLVE_ROUTE = '/api/drag-out.resolve'
    const STYLE_ID = 'ddo-style'
    const DRAG_THRESHOLD = 4
    const SETTLE_MS = 1600

    /**
     * React is a platform seed word; the guard keeps an unfamiliar module table
     * from throwing at load time and blanking the delivery card.
     */
    let React = null
    try {
      React = require('react')
    } catch {
      React = null
    }

    const h = (type, props, ...children) => {
      if (React && typeof React.createElement === 'function') return React.createElement(type, props, ...children)
      return { type, props: { ...(props ?? {}), children: children.length > 1 ? children : children[0] } }
    }

    /** Base for the grip: a real React class when React is seeded, a stub otherwise. */
    const Base = (() => {
      if (React && typeof React.Component === 'function') return React.Component
      return class {
        constructor(props) {
          this.props = props ?? {}
          this.state = {}
        }
        setState(next) {
          this.state = { ...this.state, ...(typeof next === 'function' ? next(this.state) : next) }
        }
      }
    })()

    // ---------------------------------------------------------------------
    // Styles. Everything is currentColor plus translucent greys, so the grip
    // follows the active light/dark theme instead of pinning a palette.
    // ---------------------------------------------------------------------
    const STYLES = `
      .ddo-grip {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        flex: none;
        height: 22px;
        padding: 0 7px;
        border-radius: 6px;
        border: 1px solid rgba(127, 127, 127, .28);
        background: rgba(127, 127, 127, .10);
        color: inherit;
        font-family: inherit;
        font-size: 11px;
        line-height: 1;
        cursor: grab;
        user-select: none;
        -webkit-user-select: none;
        touch-action: none;
        opacity: .85;
        transition: background .12s ease, opacity .12s ease, border-color .12s ease;
      }
      .ddo-grip:hover { background: rgba(127, 127, 127, .20); opacity: 1; }
      .ddo-grip.ddo-dragging { cursor: grabbing; background: rgba(127, 127, 127, .26); opacity: 1; }
      .ddo-grip.ddo-preparing { cursor: progress; opacity: .7; }
      .ddo-grip.ddo-error { border-color: rgba(229, 72, 77, .55); color: rgba(229, 72, 77, .95); }
      .ddo-glyph { width: 8px; height: 12px; flex: none; display: block; opacity: .8; }
      .ddo-glyph circle { fill: currentColor; }
      .ddo-text { white-space: nowrap; }
    `

    function ensureStyle() {
      if (typeof document === 'undefined') return
      if (document.getElementById(STYLE_ID)) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = STYLES
      const head = document.head ?? document.documentElement
      if (head) head.appendChild(style)
    }

    /** Plugin context, kept so the app's own file-drag service can be looked up late. */
    let pluginCtx = null

    /**
     * The app's own `fileDrag` service (DSH 0.2.2-rc.3+), when it is mounted.
     * Looked up on demand: entry order decides who provides it first.
     */
    function sharedFileDrag() {
      if (pluginCtx === null) return null
      try {
        const service = typeof pluginCtx.get === 'function' ? pluginCtx.get('fileDrag') : undefined
        if (service !== null && typeof service === 'object' && typeof service.actions?.prepare === 'function') {
          return service
        }
      } catch {
        // not mounted on this build
      }
      return null
    }

    /** Byte route: the same delivered file, read back for a pathless drag. */
    const BYTES_ROUTE = '/api/drag-out.bytes'

    // ---------------------------------------------------------------------
    // Desktop capability. The Electron shell exposes dshDesktop.fileDrag only
    // on its own dsh-app:// origin, so a plain browser tab renders nothing.
    // ---------------------------------------------------------------------
    function desktopDrag() {
      if (typeof window === 'undefined') return null
      const api = window.dshDesktop && window.dshDesktop.fileDrag
      if (!api) return null
      if (typeof api.prepare !== 'function' || typeof api.start !== 'function') return null
      return api
    }

    const FALLBACK = {
      label: '拖出',
      hint: '按住拖到微信、Word 等应用',
      preparing: '准备中…',
      error: '拖出失败',
    }

    function translator(seat) {
      return (key) => {
        if (typeof seat === 'function') {
          const text = seat(key)
          if (typeof text === 'string' && text.length > 0 && text !== key) return text
        }
        return FALLBACK[key] ?? key
      }
    }

    // ---------------------------------------------------------------------
    // Coordinates. The delivery card hands this slot an actionUrl, the
    // authenticated present route for exactly one delivered file. The desktop
    // half refuses anything without a Session, so parse it and never guess.
    // ---------------------------------------------------------------------
    function coordinatesOf(actionUrl) {
      if (typeof actionUrl !== 'string') return null
      const at = actionUrl.indexOf('?')
      if (at === -1) return null
      let params
      try {
        params = new URLSearchParams(actionUrl.slice(at + 1))
      } catch {
        return null
      }
      const sessionId = params.get('sessionId')
      const seq = coordinate(params.get('seq'))
      const index = coordinate(params.get('index'))
      if (typeof sessionId !== 'string' || sessionId.length === 0 || seq === null || index === null) return null
      return { sessionId, seq, index }
    }

    function coordinate(value) {
      if (typeof value !== 'string' || !/^\d+$/u.test(value)) return null
      const number = Number(value)
      return Number.isSafeInteger(number) ? number : null
    }

    let counter = 0

    function requestId() {
      try {
        if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
      } catch {
        // fall through to the counter
      }
      counter += 1
      return `ddo-${Date.now().toString(36)}-${counter}`
    }

    /**
     * Turn this card's coordinates into something the shell can drag.
     *
     * Two backends, in order:
     *  - `shell`: hand the desktop shell the file's own path, so the drag carries
     *    the real file with zero copies. Fast, but the shell rebuilds the drag
     *    name from `mediaType` and refuses the gesture when that rebuild no
     *    longer equals the file on disk.
     *  - `service`: drive the app's own `fileDrag` service with the byte route.
     *    A byte drag has no path to match, so it survives any name rewrite.
     */
    async function prepareHandle(api, actionUrl, id) {
      const coordinates = coordinatesOf(actionUrl)
      if (coordinates === null) throw new Error('dsh-drag-out: the card carried no coordinates')
      const query = new URLSearchParams({
        sessionId: coordinates.sessionId,
        seq: String(coordinates.seq),
        index: String(coordinates.index),
      })
      const response = await fetch(`${RESOLVE_ROUTE}?${query.toString()}`, {
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { accept: 'application/json' },
      })
      if (!response.ok) throw new Error(`dsh-drag-out: the Host did not resolve the file (${response.status})`)
      const value = await response.json()
      if (typeof value !== 'object' || value === null) throw new Error('dsh-drag-out: unusable resolution')
      if (typeof value.address !== 'string' || value.address.length === 0) throw new Error('dsh-drag-out: unusable address')
      if (typeof value.name !== 'string' || value.name.length === 0) throw new Error('dsh-drag-out: unusable name')
      const mediaType =
        typeof value.mediaType === 'string' && value.mediaType.length > 0
          ? value.mediaType
          : 'application/octet-stream'
      const extension =
        typeof value.extension === 'string' && /^[A-Za-z\d_-]+$/u.test(value.extension)
          ? value.extension
          : undefined

      if (api !== null) {
        const source = { kind: 'resource', address: value.address, mediaType, name: value.name }
        // The shell derives a suffix from `mediaType` whenever the declared type
        // has no extension compatible with the real name, which is exactly what
        // stops it matching the file on disk. Pinning the real suffix keeps the
        // rebuilt name equal to the file.
        if (extension !== undefined) source.outputExtension = extension
        try {
          const handle = await api.prepare(source, id)
          if (typeof handle === 'string' && handle.length > 0) {
            return { backend: 'shell', api, id, handle }
          }
        } catch {
          // fall through to the service backend
        }
      }

      // Fallback A: hand the shell the bytes instead of a path. A byte drag has
      // no path to compare against, so it survives any name rewrite.
      if (api !== null) {
        try {
          const body = await fetch(`${BYTES_ROUTE}?${query.toString()}`, {
            credentials: 'same-origin',
            cache: 'no-store',
          })
          if (body.ok) {
            const buffer = await body.arrayBuffer()
            const source = {
              kind: 'bytes',
              bytes: new Uint8Array(buffer),
              mediaType,
              name: value.name,
            }
            if (extension !== undefined) source.outputExtension = extension
            const handle = await api.prepare(source, id)
            if (typeof handle === 'string' && handle.length > 0) {
              return { backend: 'shell', api, id, handle }
            }
          }
        } catch {
          // fall through to the service backend
        }
      }

      // Fallback B: drive the app's own service with the byte route.
      if (sharedFileDrag() !== null) {
        const service = sharedFileDrag()
        const controller = new AbortController()
        const transfer = await service.actions.prepare(
          {
            kind: 'url',
            url: `${BYTES_ROUTE}?${query.toString()}`,
            name: value.name,
            mediaType,
            ...(extension === undefined ? {} : { outputExtension: extension }),
          },
          controller.signal,
        )
        if (transfer !== null && typeof transfer === 'object' && typeof transfer.start === 'function') {
          return { backend: 'service', service, transfer, controller }
        }
      }

      throw new Error('dsh-drag-out: the desktop shell refused this file (the drag name no longer matches it)')
    }

    /**
     * Start whichever backend the preparation settled on.
     * @param prepared - value returned by `prepareHandle`.
     * @returns whether a drag really began.
     */
    function startPrepared(prepared) {
      if (prepared.backend === 'shell') return prepared.api.start(prepared.handle)
      // The service fires the native drag itself; its own overlay reports failures.
      prepared.transfer.start()
      return true
    }

    /**
     * Give a prepared drag back without starting it.
     * @param prepared - value returned by `prepareHandle`.
     */
    function releasePrepared(prepared) {
      if (prepared === null || prepared === undefined) return
      try {
        if (prepared.backend === 'shell') {
          quiet(prepared.api.release(prepared.handle))
        } else {
          prepared.transfer.release()
          prepared.controller?.abort()
        }
      } catch {
        // the shell already forgot this handle
      }
    }

    function quiet(outcome) {
      if (outcome && typeof outcome.catch === 'function') outcome.catch(() => {})
    }

    function cancelQuietly(api, id) {
      if (api === null || typeof id !== 'string') return
      try {
        quiet(api.cancel(id))
      } catch {
        // the shell already forgot this request
      }
    }

    // ---------------------------------------------------------------------
    // The grip. A click must keep opening the preview, so the gesture only
    // leaves the button once the pointer actually travels. The handle is
    // warmed on press and released again if the pointer comes up un-dragged.
    // ---------------------------------------------------------------------
    class DragOutAction extends Base {
      constructor(props) {
        super(props)
        this.state = { phase: 'idle' }
        this.gesture = null
        this.timer = null
        this.alive = false
      }

      componentDidMount() {
        this.alive = true
        ensureStyle()
      }

      componentWillUnmount() {
        this.alive = false
        if (this.timer !== null) {
          clearTimeout(this.timer)
          this.timer = null
        }
        const current = this.gesture
        this.gesture = null
        if (current !== null) {
          current.cancelled = true
          releasePrepared(current.prepared)
          current.prepared = null
        }
      }

      settle(phase, detail) {
        if (this.timer !== null) {
          clearTimeout(this.timer)
          this.timer = null
        }
        if (!this.alive) return
        this.setState({ phase, detail: phase === 'error' ? String(detail ?? '') : '' })
        if (phase === 'error') {
          this.timer = setTimeout(() => {
            this.timer = null
            if (this.alive) this.setState({ phase: 'idle', detail: '' })
          }, SETTLE_MS)
        }
      }

      press = (event) => {
        const api = desktopDrag()
        const { actionUrl, available } = this.props
        if ((api === null && sharedFileDrag() === null) || available === false || typeof actionUrl !== 'string') return
        if (event.pointerType === 'mouse' && event.button !== 0) return
        if (event.pointerType !== 'mouse' && event.isPrimary === false) return
        event.preventDefault()
        event.stopPropagation()

        const previous = this.gesture
        if (previous !== null) {
          previous.cancelled = true
          releasePrepared(previous.prepared)
          previous.prepared = null
        }

        const id = requestId()
        const current = { id, cancelled: false, started: false, prepared: null, promise: null }
        this.gesture = current
        const originX = event.clientX
        const originY = event.clientY

        // Warm the handle on press: resolving coordinates and hashing the file
        // is the slow part, and folding it into the gesture lead-in keeps the
        // drag itself feeling instant.
        current.promise = prepareHandle(api, actionUrl, id)
        current.promise.then(
          (prepared) => {
            if (current.cancelled) {
              releasePrepared(prepared)
              return
            }
            current.prepared = prepared
          },
          () => {},
        )

        const detach = () => {
          window.removeEventListener('pointermove', onMove, true)
          window.removeEventListener('pointerup', onUp, true)
          window.removeEventListener('pointercancel', onUp, true)
        }

        const onMove = (moveEvent) => {
          if (current.cancelled || current.started) return
          if (Math.abs(moveEvent.clientX - originX) + Math.abs(moveEvent.clientY - originY) < DRAG_THRESHOLD) return
          current.started = true
          this.settle('preparing')
          void (async () => {
            try {
              const prepared = current.prepared ?? (await current.promise)
              current.prepared = null
              if (current.cancelled) {
                releasePrepared(prepared)
                return
              }
              this.settle('dragging')
              // Both backends consume the prepared source whether or not the OS
              // really took the pointer.
              const began = await startPrepared(prepared)
              this.settle(began === true ? 'idle' : 'error', 'the desktop shell did not start the drag')
            } catch (error) {
              this.settle(current.cancelled ? 'idle' : 'error', error instanceof Error ? error.message : '')
            } finally {
              detach()
              if (this.gesture === current) this.gesture = null
            }
          })()
        }

        const onUp = () => {
          current.cancelled = true
          detach()
          if (this.gesture === current) this.gesture = null
          if (current.prepared !== null) {
            releasePrepared(current.prepared)
            current.prepared = null
          }
          cancelQuietly(api, id)
          this.settle('idle')
        }

        window.addEventListener('pointermove', onMove, true)
        window.addEventListener('pointerup', onUp, true)
        window.addEventListener('pointercancel', onUp, true)
      }

      swallow = (event) => {
        event.preventDefault()
        event.stopPropagation()
      }

      render() {
        const api = desktopDrag()
        const { actionUrl, available } = this.props
        if ((api === null && sharedFileDrag() === null) || available === false || typeof actionUrl !== 'string') return null
        const t = translator(this.props.t)
        const phase = this.state.phase ?? 'idle'
        const detail = typeof this.state.detail === 'string' ? this.state.detail : ''
        const label = phase === 'preparing' ? t('preparing') : phase === 'error' ? t('error') : t('label')
        return h(
          'button',
          {
            type: 'button',
            className: `ddo-grip ddo-${phase}`,
            // On failure the tooltip carries the real reason, so a report never
            // has to guess why the shell declined.
            title: phase === 'error' ? detail || t('error') : t('hint'),
            'aria-label': t('label'),
            draggable: false,
            onPointerDown: this.press,
            onClick: this.swallow,
          },
          h(
            'svg',
            { className: 'ddo-glyph', viewBox: '0 0 8 12', 'aria-hidden': 'true', focusable: 'false' },
            h('circle', { cx: 2, cy: 2, r: 1.15 }),
            h('circle', { cx: 6, cy: 2, r: 1.15 }),
            h('circle', { cx: 2, cy: 6, r: 1.15 }),
            h('circle', { cx: 6, cy: 6, r: 1.15 }),
            h('circle', { cx: 2, cy: 10, r: 1.15 }),
            h('circle', { cx: 6, cy: 10, r: 1.15 }),
          ),
          h('span', { className: 'ddo-text' }, label),
        )
      }
    }

    /** Dictionaries: Chinese is the default here; English keeps the grip readable. */
    const ZH = {
      label: '拖出',
      hint: '按住拖到微信、Word 等应用',
      preparing: '准备中…',
      error: '拖出失败',
    }

    const EN = {
      label: 'Drag out',
      hint: 'Press and drag into WeChat, Word, …',
      preparing: 'Preparing…',
      error: 'Drag failed',
    }

    function apply(ctx) {
      // DSH 0.2.2-rc.3 ships a file-drag service of its own. Reusing it gives a
      // byte-backed drag path when the shell refuses a path-backed one, and it
      // already renders the app's own failure notice. Older builds have none, so
      // the context is kept and the service looked up per drag, not once here.
      pluginCtx = ctx
      ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), 'dsh-drag-out: dictionaries')
      ctx.slots.inject('deliverables.file.actions', () =>
        ctx.slots.register(
          {
            name: 'deliverables.file.actions',
            id: 'drag-out',
            locale: NS,
          },
          DragOutAction,
        ),
      )
    }

    exports.inject = ['slots', 'locale']
    exports.apply = apply

    return module.exports
  },
})

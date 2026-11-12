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
     * Turn this card's coordinates into a desktop-draggable handle: the Host
     * resolves the delivered path, the shell prepares a native drag source.
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
      const handle = await api.prepare({ kind: 'resource', address: value.address, mediaType, name: value.name }, id)
      if (typeof handle !== 'string' || handle.length === 0) throw new Error('dsh-drag-out: the shell refused the drag')
      return handle
    }

    function quiet(outcome) {
      if (outcome && typeof outcome.catch === 'function') outcome.catch(() => {})
    }

    function releaseQuietly(api, handle) {
      if (api === null || typeof handle !== 'string') return
      try {
        quiet(api.release(handle))
      } catch {
        // the shell already forgot this handle
      }
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
        const api = desktopDrag()
        const current = this.gesture
        this.gesture = null
        if (current !== null) {
          current.cancelled = true
          if (typeof current.handle === 'string') {
            releaseQuietly(api, current.handle)
            current.handle = null
          }
        }
      }

      settle(phase) {
        if (this.timer !== null) {
          clearTimeout(this.timer)
          this.timer = null
        }
        if (!this.alive) return
        this.setState({ phase })
        if (phase === 'error') {
          this.timer = setTimeout(() => {
            this.timer = null
            if (this.alive) this.setState({ phase: 'idle' })
          }, SETTLE_MS)
        }
      }

      press = (event) => {
        const api = desktopDrag()
        const { actionUrl, available } = this.props
        if (api === null || available === false || typeof actionUrl !== 'string') return
        if (event.pointerType === 'mouse' && event.button !== 0) return
        if (event.pointerType !== 'mouse' && event.isPrimary === false) return
        event.preventDefault()
        event.stopPropagation()

        const previous = this.gesture
        if (previous !== null) {
          previous.cancelled = true
          if (typeof previous.handle === 'string') {
            releaseQuietly(api, previous.handle)
            previous.handle = null
          }
        }

        const id = requestId()
        const current = { id, cancelled: false, started: false, handle: null, promise: null }
        this.gesture = current
        const originX = event.clientX
        const originY = event.clientY

        // Warm the handle on press: resolving coordinates and hashing the file
        // is the slow part, and folding it into the gesture lead-in keeps the
        // drag itself feeling instant.
        current.promise = prepareHandle(api, actionUrl, id)
        current.promise.then(
          (handle) => {
            if (current.cancelled) {
              releaseQuietly(api, handle)
              return
            }
            current.handle = handle
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
              const prepared = await current.promise
              const handle = typeof current.handle === 'string' ? current.handle : prepared
              current.handle = null
              if (current.cancelled) {
                releaseQuietly(api, handle)
                return
              }
              this.settle('dragging')
              // start() consumes the handle whether or not the shell accepted it.
              const began = await api.start(handle)
              this.settle(began === true ? 'idle' : 'error')
            } catch {
              this.settle(current.cancelled ? 'idle' : 'error')
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
          if (typeof current.handle === 'string') {
            releaseQuietly(api, current.handle)
            current.handle = null
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
        if (api === null || available === false || typeof actionUrl !== 'string') return null
        const t = translator(this.props.t)
        const phase = this.state.phase ?? 'idle'
        const label = phase === 'preparing' ? t('preparing') : phase === 'error' ? t('error') : t('label')
        return h(
          'button',
          {
            type: 'button',
            className: `ddo-grip ddo-${phase}`,
            title: phase === 'error' ? t('error') : t('hint'),
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

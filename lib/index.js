/**
 * dsh-drag-out — host half.
 *
 * Resolves one Presented deliverable — the coordinates a delivery card already
 * carries (session, event seq, file index) — into a `dsh-resource://` address
 * that the desktop shell turns into a real OS drag.
 *
 * Read-only throughout: the file is never copied, moved, or rewritten. The
 * browser half asks, the desktop shell authorizes, the OS moves the pointer.
 */

import { readFile } from 'node:fs/promises'

/** Services this row needs: one authenticated route plus the Session lookup. */
export const inject = ['connection', 'sessionQuery', 'workspaceFiles', 'sandboxPolicy']

/** Authenticated route the browser half calls before starting a drag. */
const RESOLVE_PATH = '/api/drag-out.resolve'

/**
 * Authenticated route that streams the same file back as bytes.
 *
 * The desktop shell can only start a real drag from a path it finished
 * verifying, and it rebuilds that path's name from the request. When the two
 * disagree — a rewritten suffix, a name longer than the shell keeps — the shell
 * refuses the file-backed drag. A byte drag has no path to match, so it is the
 * fallback that still puts the file under the pointer.
 */
const BYTES_PATH = '/api/drag-out.bytes'

/** Largest file this route will read into memory for the fallback drag. */
const MAX_BYTES = 128 * 1024 * 1024

const NUMERIC = /^\d+$/u

const MEDIA_BY_EXT = new Map(
  Object.entries({
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.avif': 'image/avif',
    '.bmp': 'image/bmp',
    '.svg': 'image/svg+xml',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mov': 'video/mov',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.ogg': 'audio/ogg',
    '.flac': 'audio/flac',
    '.m4a': 'audio/mp4',
    '.pdf': 'application/pdf',
    '.glb': 'model/gltf-binary',
    '.gltf': 'model/gltf+json',
    '.stl': 'model/stl',
    '.zip': 'application/zip',
    '.md': 'text/markdown',
    '.txt': 'text/plain',
    '.json': 'application/json',
    '.csv': 'text/csv',
  }),
)

/**
 * Parse one non-negative integer query coordinate.
 * @param value - raw query value, or null.
 * @returns the integer, or undefined when absent or malformed.
 */
function coordinate(value) {
  return value !== null && NUMERIC.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : undefined
}

/**
 * Trailing path segment, the part the desktop shell matches a drag name against.
 * @param value - slash- or backslash-separated path.
 * @returns the final segment.
 */
function basename(value) {
  const at = Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\'))
  return at === -1 ? value : value.slice(at + 1)
}

/**
 * Whether durable event data carries a file list.
 * @param value - decoded `deliverables/presented` payload.
 * @returns whether `files` is an array.
 */
function isPresentedFiles(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Array.isArray(value.files)
}

/**
 * Whether one declaration names a usable file.
 * @param value - one entry of the delivery's `files` array.
 * @returns whether it carries a non-empty path.
 */
function isPresentedFile(value) {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof value.path === 'string' &&
    value.path.trim().length > 0
  )
}

/**
 * Build the Session-scoped address the desktop host authorizes drags for.
 * @param sessionId - owning Session.
 * @param absolutePath - verified Host path of the file.
 * @returns a `dsh-resource://file/session/<id>/<segments>` URI.
 */
function fileAddress(sessionId, absolutePath) {
  const segments = absolutePath.split(/[/\\]+/u).filter((segment) => segment.length > 0)
  return (
    'dsh-resource://file/session/' +
    encodeURIComponent(sessionId) +
    '/' +
    segments.map((segment) => encodeURIComponent(segment)).join('/')
  )
}

/**
 * Guess a media type from the file name.
 * @param name - base name including extension.
 * @returns a media type, falling back to `application/octet-stream`.
 */
function mediaTypeOf(name) {
  const at = name.lastIndexOf('.')
  const extension = at === -1 ? '' : name.slice(at).toLowerCase()
  return MEDIA_BY_EXT.get(extension) ?? 'application/octet-stream'
}

/**
 * Extension the desktop shell must rebuild the drag name with.
 *
 * The shell derives a suffix from `mediaType` whenever the declared type has no
 * extension compatible with the real name — a Markdown file declared as
 * `text/plain` becomes `note.txt`, an unknown suffix becomes `file.bin`. That
 * rewrite makes `basename(path) === resolveDragFileName(source)` fail, so the
 * shell silently refuses the drag. Passing the real suffix as
 * `outputExtension` pins the name back to the file on disk.
 *
 * @param name - base name including extension.
 * @returns the suffix without its dot, or undefined when absent or unusable.
 */
function extensionOf(name) {
  const at = name.lastIndexOf('.')
  if (at === -1 || at === name.length - 1) return undefined
  const suffix = name.slice(at + 1)
  return /^[A-Za-z\d_-]+$/u.test(suffix) ? suffix : undefined
}

/**
 * Map a lookup or filesystem failure onto the status the card retries from.
 * @param error - thrown value.
 * @returns 404 for absent coordinates, 500 otherwise.
 */
function statusOf(error) {
  const code =
    typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : ''
  return code === 'session/not-found' ||
    code === 'workspace-file/not-found' ||
    code === 'workspace-file/not-regular-file' ||
    code === 'SESSION_QUERY_SESSION_NOT_FOUND' ||
    code === 'SESSION_QUERY_EVENT_NOT_FOUND' ||
    code === 'ENOENT' ||
    code === 'ENOTDIR'
    ? 404
    : 500
}

/**
 * Status for a locate failure: malformed coordinates are the caller's mistake,
 * everything else is missing data.
 * @param error - thrown value.
 * @returns 400, 404, or 500.
 */
function failureStatus(error) {
  return typeof error?.code === 'string' && error.code === 'drag-out/invalid-coordinates'
    ? 400
    : statusOf(error)
}

/**
 * Read the coordinates of one card and resolve them to the file behind it.
 * @param ctx - host context carrying the Session lookup and workspace files.
 * @param request - authenticated GET request.
 * @returns the Session, the verified absolute path, and its base name.
 */
async function locate(ctx, request) {
  const query = new URL(request.url).searchParams
  const sessionId = query.get('sessionId')
  const seq = coordinate(query.get('seq'))
  const index = coordinate(query.get('index'))
  if (sessionId === null || sessionId === '' || seq === undefined || index === undefined) {
    const error = new Error('Invalid drag-out coordinates.')
    error.code = 'drag-out/invalid-coordinates'
    throw error
  }
  const window = await ctx.sessionQuery.readEvent(
    { sessionId, seq, before: 0, after: 0 },
    request.signal,
  )
  const target = window.target
  const data = target?.type === 'deliverables/presented' ? target.data : undefined
  const file = isPresentedFiles(data) ? data.files[index] : undefined
  if (!isPresentedFile(file)) {
    const error = new Error('Presented file not found.')
    error.code = 'session/not-found'
    throw error
  }
  request.signal.throwIfAborted()
  const workspaceRoot = window.session?.cwd ?? ctx.sandboxPolicy.workspaceRoot
  const stat = await ctx.workspaceFiles.stat({ sessionId, workspaceRoot }, file.path, request.signal)
  return { sessionId, name: basename(stat.absolutePath), absolutePath: stat.absolutePath }
}

/**
 * Answer one resolve request: coordinates in, draggable address out.
 * @param ctx - host context carrying the Session lookup and workspace files.
 * @param request - authenticated GET request.
 * @returns the JSON payload, or a failure response.
 */
async function handleResolve(ctx, request) {
  try {
    const found = await locate(ctx, request)
    const extension = extensionOf(found.name)
    return Response.json(
      {
        address: fileAddress(found.sessionId, found.absolutePath),
        name: found.name,
        mediaType: mediaTypeOf(found.name),
        ...(extension === undefined ? {} : { extension }),
      },
      { headers: { 'cache-control': 'no-store' } },
    )
  } catch (error) {
    return new Response('Presented file unavailable.', { status: failureStatus(error) })
  }
}

/**
 * Answer one byte request: the same file, streamed back for a fallback drag.
 * @param ctx - host context carrying the Session lookup and workspace files.
 * @param request - authenticated GET request.
 * @returns the file body, or a failure response.
 */
async function handleBytes(ctx, request) {
  try {
    const found = await locate(ctx, request)
    const bytes = await readFile(found.absolutePath)
    if (bytes.byteLength > MAX_BYTES) {
      return new Response('Presented file is too large to drag as bytes.', { status: 413 })
    }
    return new Response(bytes, {
      headers: {
        'content-type': mediaTypeOf(found.name),
        'content-length': String(bytes.byteLength),
        'cache-control': 'no-store',
      },
    })
  } catch (error) {
    return new Response('Presented file unavailable.', { status: failureStatus(error) })
  }
}

/**
 * Register both routes inside Connection's authentication fence.
 * @param ctx - host context.
 */
export function apply(ctx) {
  ctx.connection.fetch.register({
    path: RESOLVE_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: (request) => handleResolve(ctx, request),
  })
  ctx.connection.fetch.register({
    path: BYTES_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: (request) => handleBytes(ctx, request),
  })
}

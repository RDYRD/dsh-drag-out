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

/** Services this row needs: one authenticated route plus the Session lookup. */
export const inject = ['connection', 'sessionQuery', 'workspaceFiles', 'sandboxPolicy']

/** Authenticated route the browser half calls before starting a drag. */
const RESOLVE_PATH = '/api/drag-out.resolve'

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
 * Answer one resolve request: coordinates in, draggable address out.
 * @param ctx - host context carrying the Session lookup and workspace files.
 * @param request - authenticated GET request.
 * @returns the JSON payload, or a failure response.
 */
async function handleResolve(ctx, request) {
  const query = new URL(request.url).searchParams
  const sessionId = query.get('sessionId')
  const seq = coordinate(query.get('seq'))
  const index = coordinate(query.get('index'))
  if (sessionId === null || sessionId === '' || seq === undefined || index === undefined) {
    return new Response('Invalid drag-out coordinates.', { status: 400 })
  }
  try {
    const window = await ctx.sessionQuery.readEvent(
      { sessionId, seq, before: 0, after: 0 },
      request.signal,
    )
    const target = window.target
    const data = target?.type === 'deliverables/presented' ? target.data : undefined
    const file = isPresentedFiles(data) ? data.files[index] : undefined
    if (!isPresentedFile(file)) return new Response('Presented file not found.', { status: 404 })
    request.signal.throwIfAborted()
    const workspaceRoot = window.session?.cwd ?? ctx.sandboxPolicy.workspaceRoot
    const stat = await ctx.workspaceFiles.stat(
      { sessionId, workspaceRoot },
      file.path,
      request.signal,
    )
    const name = basename(stat.absolutePath)
    return Response.json(
      {
        address: fileAddress(sessionId, stat.absolutePath),
        name,
        mediaType: mediaTypeOf(name),
      },
      { headers: { 'cache-control': 'no-store' } },
    )
  } catch (error) {
    return new Response('Presented file unavailable.', { status: statusOf(error) })
  }
}

/**
 * Register the resolve route inside Connection's authentication fence.
 * @param ctx - host context.
 */
export function apply(ctx) {
  ctx.connection.fetch.register({
    path: RESOLVE_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: (request) => handleResolve(ctx, request),
  })
}

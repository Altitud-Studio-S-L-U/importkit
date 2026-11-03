import { checkAbort, ImportKitError } from '../errors.js';
import type { ByteSource, OpenedSource, SourceContext } from '../types.js';

export interface HttpSourceOptions {
  /** Request headers, such as an authorization token. They are sent with the request and never appear in errors. */
  readonly headers?: Readonly<Record<string, string>>;
}

function responseError(message: string): ImportKitError {
  return new ImportKitError('SOURCE_ERROR', message);
}

/** The body of one response, read once. A run that stops early cancels it, which releases the connection. */
class OpenedResponse implements OpenedSource {
  readonly identity: string;
  readonly size: number;
  readonly #response: Response;
  #reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  #settled = false;

  constructor(response: Response, identity: string, size: number) {
    this.#response = response;
    this.identity = identity;
    this.size = size;
  }

  async *bytes(): AsyncIterable<Uint8Array> {
    const body = this.#response.body;
    if (body === null) {
      this.#settled = true;
      return;
    }
    const reader = body.getReader();
    this.#reader = reader;
    while (true) {
      let next: ReadableStreamReadResult<Uint8Array>;
      try {
        next = await reader.read();
      } catch (error) {
        this.#settled = true;
        throw error;
      }
      if (next.done) {
        this.#settled = true;
        return;
      }
      yield next.value;
    }
  }

  async close(): Promise<void> {
    if (this.#settled) return;
    this.#settled = true;
    try {
      await (this.#reader ?? this.#response.body)?.cancel();
    } catch (error) {
      throw new ImportKitError('SOURCE_ERROR', 'Unable to cancel the source response.', { cause: error });
    }
  }
}

/** Accepts only a complete, unencoded response whose ETag and Content-Length identify and bound its content. */
function openResponse(response: Response, maxBytes: number): OpenedResponse {
  const { status, headers } = response;
  if (response.type === 'opaqueredirect' || (status >= 300 && status < 400)) {
    throw responseError('The source responded with a redirect. Pass the final URL: ImportKit does not follow redirects.');
  }
  if (status !== 200) throw responseError(`The source responded with HTTP status ${status}.`);
  const encoding = headers.get('content-encoding');
  if (encoding !== null && encoding.trim().toLowerCase() !== 'identity') {
    throw responseError('The source must send the content without Content-Encoding.');
  }
  const etag = headers.get('etag');
  if (etag === null || etag.length === 0) {
    throw responseError('The response must carry an ETag, so that a resumed run can tell whether the content changed.');
  }
  if (etag.startsWith('W/')) throw responseError('The response must carry a strong ETag: a weak one can stay the same when the content changes.');
  if (etag.length > 256) throw responseError('The response ETag exceeds 256 characters.');
  const length = headers.get('content-length');
  if (length === null || !/^\d{1,16}$/u.test(length) || !Number.isSafeInteger(Number(length))) {
    throw responseError('The response must declare its Content-Length.');
  }
  const size = Number(length);
  if (size > maxBytes) throw new ImportKitError('LIMIT_EXCEEDED', 'The source exceeds maxSourceBytes.');
  return new OpenedResponse(response, `etag:${etag}`, size);
}

/**
 * Reads a file over HTTP or HTTPS, such as an object in S3, Google Cloud Storage or R2 through a presigned URL. Each
 * run sends one GET request. The response's strong ETag is the source's identity, so a resumed run only continues while
 * the server returns the same version.
 */
export function httpSource(url: string | URL, options: HttpSourceOptions = {}): ByteSource {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    throw new ImportKitError('INVALID_OPTIONS', 'httpSource needs an absolute http or https URL.');
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw new ImportKitError('INVALID_OPTIONS', 'httpSource needs an absolute http or https URL.');
  }
  if (target.username !== '' || target.password !== '') {
    throw new ImportKitError('INVALID_OPTIONS', 'Pass credentials in headers, not in the URL.');
  }
  let headers: Headers;
  try {
    headers = new Headers(options.headers);
  } catch {
    throw new ImportKitError('INVALID_OPTIONS', 'headers must hold valid HTTP header names and values.');
  }
  // A decoded body would not match the Content-Length or the representation that the ETag names.
  headers.set('accept-encoding', 'identity');
  const href = target.href;

  return Object.freeze({
    async open({ maxBytes, signal }: SourceContext): Promise<OpenedSource> {
      let response: Response;
      try {
        // Redirects are refused, not followed: following one could send the request and its headers to another host.
        response = await fetch(href, { headers, redirect: 'manual', ...(signal === undefined ? {} : { signal }) });
      } catch (error) {
        checkAbort(signal);
        throw new ImportKitError('SOURCE_ERROR', 'Unable to fetch the source.', { cause: error });
      }
      try {
        return openResponse(response, maxBytes);
      } catch (error) {
        try {
          await response.body?.cancel();
        } catch {
          // The rejection below explains the failure, and a body that cannot be cancelled has already ended.
        }
        throw error;
      }
    },
  });
}

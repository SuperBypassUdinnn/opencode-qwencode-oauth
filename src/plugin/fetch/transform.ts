import { transformResponsesToChatCompletions } from "../../transform/request";

export function sanitizeMalformedUrl(url: string): string {
  let result = url.trim();

  result = result.replace(/^(undefined|null)(?=\/|$)/, "");

  if (result.startsWith("//")) {
    result = `/${result.replace(/^\/+/, "")}`;
  }

  return result;
}

export function applyResourceUrl(
  input: RequestInfo | URL,
  baseUrl?: string,
): { url: string } {
  let rawUrl: string;
  if (typeof input === "string") {
    rawUrl = input;
  } else if (input instanceof URL) {
    rawUrl = input.toString();
  } else {
    rawUrl = (input as Request).url;
  }

  rawUrl = sanitizeMalformedUrl(rawUrl);

  if (!rawUrl) {
    rawUrl = "/";
  }

  let originalUrl: URL;
  try {
    originalUrl = new URL(rawUrl);
  } catch {
    if (!baseUrl) {
      throw new Error(`Qwen OAuth requires a base URL for ${rawUrl}`);
    }
    originalUrl = new URL(rawUrl, baseUrl);
  }

  if (!baseUrl) {
    return { url: originalUrl.toString() };
  }

  const base = new URL(baseUrl);
  const basePath = base.pathname.replace(/\/$/, "");
  const originalPath = originalUrl.pathname;

  let combinedPath = originalPath;
  if (originalPath.startsWith(basePath)) {
    combinedPath = `${basePath}${originalPath.slice(basePath.length)}`;
  } else {
    combinedPath = `${basePath}${originalPath.startsWith("/") ? "" : "/"}${originalPath}`;
  }

  base.pathname = combinedPath;
  base.search = originalUrl.search;
  base.hash = originalUrl.hash;

  return { url: base.toString() };
}

export interface TransformResult {
  url: string;
  init: RequestInit;
  needsResponsesTransform: boolean;
}

export async function transformRequestAsync(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<TransformResult> {
  let rawUrl: string;
  if (typeof input === "string") {
    rawUrl = input;
  } else if (input instanceof URL) {
    rawUrl = input.toString();
  } else {
    rawUrl = input.url;
  }

  rawUrl = sanitizeMalformedUrl(rawUrl);

  if (!rawUrl) {
    rawUrl = "/";
  }

  let requestInit =
    init ??
    (input instanceof Request
      ? {
          method: input.method,
          headers: input.headers,
          body: input.body,
          signal: input.signal,
        }
      : undefined);

  if (!requestInit && !(input instanceof Request)) {
    requestInit = {};
  }

  const needsResponsesTransform = rawUrl.endsWith("/responses");
  const finalUrl = rawUrl.replace(/\/responses$/, "/chat/completions");

  const finalInit = { ...requestInit };
  if (needsResponsesTransform && requestInit?.body) {
    let backupStream: ReadableStream | null = null;
    try {
      let bodyStr: string;
      if (typeof requestInit.body === "string") {
        bodyStr = requestInit.body;
      } else if (requestInit.body instanceof ReadableStream) {
        const [readStream, backup] = requestInit.body.tee();
        backupStream = backup;
        bodyStr = await new Response(readStream).text();
      } else {
        bodyStr = await new Response(requestInit.body).text();
      }
      const body = JSON.parse(bodyStr);
      const transformed = transformResponsesToChatCompletions(body);
      finalInit.body = JSON.stringify(transformed);
    } catch {
      if (backupStream) {
        finalInit.body = backupStream;
      }
    }
  }

  return {
    url: finalUrl,
    init: finalInit,
    needsResponsesTransform,
  };
}

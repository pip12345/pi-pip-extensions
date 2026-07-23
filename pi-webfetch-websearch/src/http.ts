import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";

export interface ResolvedAddress {
  address: string;
  family: number;
}

export type AddressResolver = (hostname: string) => Promise<ResolvedAddress[]>;

export interface WebRequestOptions {
  headers: Record<string, string>;
  signal: AbortSignal;
  blockPrivateHosts: boolean;
  upgradeHttp: boolean;
  maxRedirects?: number;
  resolver?: AddressResolver;
}

export interface WebResponse {
  response: Response;
  url: URL;
}

const defaultResolver: AddressResolver = async (hostname) => lookup(hostname, { all: true, verbatim: true });

function parseIPv4(host: string): [number, number, number, number] | undefined {
  const parts = host.split(".");
  if (parts.length !== 4) return undefined;
  const values = parts.map((part) => (/^\d+$/.test(part) ? Number(part) : NaN));
  if (values.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return undefined;
  return values as [number, number, number, number];
}

function isPrivateIPv4(host: string): boolean {
  const value = parseIPv4(host);
  if (!value) return true;
  const [a, b, c] = value;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)))) return true;
  if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  return a >= 224;
}

function ipv6Groups(input: string): number[] | undefined {
  let host = input.toLowerCase().split("%", 1)[0];
  const dotted = host.match(/(?:^|:)(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (dotted) {
    const v4 = parseIPv4(dotted);
    if (!v4) return undefined;
    host = `${host.slice(0, -dotted.length)}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  const halves = host.split("::");
  if (halves.length > 2) return undefined;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return undefined;
  const raw = [...left, ...Array(Math.max(0, missing)).fill("0"), ...right];
  if (raw.length !== 8 || raw.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return undefined;
  return raw.map((part) => Number.parseInt(part, 16));
}

export function isPrivateAddress(address: string): boolean {
  const host = address.replace(/^\[|\]$/g, "").toLowerCase();
  const family = isIP(host);
  if (family === 4) return isPrivateIPv4(host);
  if (family !== 6) return true;
  const groups = ipv6Groups(host);
  if (!groups) return true;
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    const mapped = `${groups[6] >> 8}.${groups[6] & 255}.${groups[7] >> 8}.${groups[7] & 255}`;
    return isPrivateIPv4(mapped);
  }
  if (groups.every((group) => group === 0)) return true;
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) return true;
  if ((groups[0] & 0xfe00) === 0xfc00) return true;
  if ((groups[0] & 0xffc0) === 0xfe80) return true;
  if ((groups[0] & 0xff00) === 0xff00) return true;
  return groups[0] === 0x2001 && groups[1] === 0x0db8;
}

export function normalizeWebUrl(input: string | URL, options: Pick<WebRequestOptions, "blockPrivateHosts" | "upgradeHttp">): URL {
  let url: URL;
  try {
    url = input instanceof URL ? new URL(input) : new URL(input);
  } catch {
    throw new Error("Invalid URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("URL must start with http:// or https://.");
  if (url.username || url.password) throw new Error("URL credentials are not allowed.");
  if (options.upgradeHttp && url.protocol === "http:") url.protocol = "https:";
  if (options.blockPrivateHosts) {
    const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (hostname === "localhost" || hostname.endsWith(".localhost") || (isIP(hostname) && isPrivateAddress(hostname))) {
      throw new Error("Blocked private or local host.");
    }
  }
  return url;
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error("Request aborted");
  error.name = "AbortError";
  return error;
}

async function waitForResolution<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) throw abortError(signal);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(abortError(signal));
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => { cleanup(); resolve(value); },
      (error) => { cleanup(); reject(error); },
    );
  });
}

export async function resolvePublicAddress(hostname: string, resolver: AddressResolver = defaultResolver, signal?: AbortSignal): Promise<ResolvedAddress> {
  const literal = hostname.replace(/^\[|\]$/g, "");
  if (isIP(literal)) {
    if (isPrivateAddress(literal)) throw new Error("Blocked private or local host.");
    return { address: literal, family: isIP(literal) };
  }
  const addresses = await waitForResolution(resolver(literal), signal);
  if (!addresses.length) throw new Error(`No addresses found for ${literal}.`);
  if (addresses.some(({ address }) => isPrivateAddress(address))) throw new Error("Blocked private or local host.");
  return addresses[0];
}

function responseHeaders(message: import("node:http").IncomingMessage): Headers {
  const headers = new Headers();
  for (let index = 0; index < message.rawHeaders.length; index += 2) {
    const name = message.rawHeaders[index];
    const value = message.rawHeaders[index + 1];
    if (name && value !== undefined) headers.append(name, value);
  }
  return headers;
}

async function requestOnce(url: URL, options: WebRequestOptions): Promise<Response> {
  const pinned = options.blockPrivateHosts ? await resolvePublicAddress(url.hostname, options.resolver, options.signal) : undefined;
  return new Promise<Response>((resolve, reject) => {
    const request = url.protocol === "https:" ? httpsRequest : httpRequest;
    const req = request(url, {
      headers: options.headers,
      signal: options.signal,
      family: pinned?.family,
      lookup: pinned
        ? ((_hostname: string, _lookupOptions: unknown, callback: (error: NodeJS.ErrnoException | null, address: string, family: number) => void) => callback(null, pinned.address, pinned.family)) as any
        : undefined,
    }, (message) => {
      const status = message.statusCode ?? 0;
      const hasBody = ![101, 204, 205, 304].includes(status);
      if (!hasBody) message.resume();
      const body = hasBody ? (Readable.toWeb(message) as ReadableStream<Uint8Array>) : null;
      resolve(new Response(body, { status, statusText: message.statusMessage, headers: responseHeaders(message) }));
    });
    req.on("error", reject);
    req.end();
  });
}

export async function requestWebUrl(input: string | URL, options: WebRequestOptions): Promise<WebResponse> {
  let url = normalizeWebUrl(input, options);
  const maxRedirects = options.maxRedirects ?? 5;
  for (let redirects = 0; ; redirects++) {
    const response = await requestOnce(url, options);
    const location = response.headers.get("location");
    if (![301, 302, 303, 307, 308].includes(response.status) || !location) return { response, url };
    await response.body?.cancel();
    if (redirects >= maxRedirects) throw new Error(`Too many redirects (limit ${maxRedirects}).`);
    url = normalizeWebUrl(new URL(location, url), options);
  }
}

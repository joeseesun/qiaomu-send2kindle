// Shared validation stays free of Node imports so the reader still loads on mobile.
export const KINDLE_PORT = 2222;
export const KINDLE_NATIVE_PORT = 2223;
export const KINDLE_FOLDER = "/mnt/us/documents";
export const KINDLE_MAX_BYTES = 512 * 1024 * 1024;
const FORMATS = new Set(["epub", "pdf", "mobi", "azw", "azw3", "fb2", "txt", "html", "htm", "cbz", "cbr", "djvu", "djv", "rtf", "chm", "doc"]);
export function kindleMode(value) { return value === "native" ? "native" : "koreader"; }
export function kindleDeliveryFormat(name, mode) {
  kindleBookName(name);
  const ext = name.split(".").pop().toLowerCase();
  if (kindleMode(mode) !== "native") return { convert: false, name };
  if (["pdf", "mobi", "azw", "azw3", "txt"].includes(ext)) return { convert: false, name };
  if (ext === "epub") return { convert: true, name: name.slice(0, -5) + ".azw3" };
  throw kindleError("native-format");
}

export function kindleError(code) { return Object.assign(new Error(code), { code }); }
export function kindleBookName(name) {
  if (typeof name !== "string" || !name || /[/\\]/.test(name) || [...name].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) || name === "." || name === "..") throw kindleError("file");
  const ext = name.split(".").pop().toLowerCase();
  if (!name.includes(".") || !FORMATS.has(ext)) throw kindleError("format");
  if ([...name].length > 180) throw kindleError("file");
  return name;
}
export function isKindleBook(file) {
  try { return !!file?.path && !!kindleBookName(file.name); } catch { return false; }
}
export function kindleConnection(raw = {}) {
  const host = String(raw.host || "").trim();
  // Only explicit local IPv4 addresses; no URLs, shell syntax, or public hosts.
  const octets = host.split(".");
  if (octets.length !== 4 || octets.some(n => !/^\d{1,3}$/.test(n) || Number(n) > 255)) throw kindleError("address");
  const [a, b] = octets.map(Number);
  if (!(a === 10 || a === 192 && b === 168 || a === 172 && b >= 16 && b <= 31)) throw kindleError("address");
  const port = Number(raw.port || (kindleMode(raw.mode) === "native" ? KINDLE_NATIVE_PORT : KINDLE_PORT));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw kindleError("address");
  const fingerprint = String(raw.fingerprint || "");
  if (fingerprint && !/^[a-f0-9]{64}$/.test(fingerprint)) throw kindleError("host-key");
  return { host: octets.map(Number).join("."), port, fingerprint, mode: kindleMode(raw.mode) };
}
export function kindleLuaSettings(source, port = KINDLE_PORT) {
  if (typeof source !== "string" || source.length > 2_000_000 || !/^\s*(?:--[^\n]*\n\s*)*return\s*\{/.test(source) || !/\}\s*$/.test(source)) throw kindleError("usb-settings");
  // KOReader writes one top-level setting per indented line. Never evaluate Lua.
  const settings = { SSH_port: JSON.stringify(String(port)), SSH_allow_no_password: "false", SSH_key_only_auth: "true", SSH_autostart: "true" };
  let output = source;
  for (const [key, value] of Object.entries(settings)) {
    const pattern = new RegExp(`^    \\["${key}"\\] = [^\\n]+,\\r?$`, "gm");
    const found = [...output.matchAll(pattern)];
    if (found.length > 1) throw kindleError("usb-settings");
    if (found.length) output = output.replace(pattern, `    ["${key}"] = ${value},`);
    else output = output.replace(/\}\s*$/, `    ["${key}"] = ${value},\n}\n`);
  }
  return output;
}
export function appendKindleKey(source, publicKey) {
  if (typeof source !== "string" || source.length > 1_000_000 || !/^ecdsa-sha2-nistp256 [A-Za-z0-9+/=]+(?: .*)?$/.test(publicKey.trim())) throw kindleError("usb-settings");
  const [type, key] = publicKey.trim().split(/\s+/);
  if (source.split(/\r?\n/).some(line => {
    if (line.trim().startsWith("#")) return false;
    const tokens = line.trim().split(/\s+/), i = tokens.indexOf(type);
    return i >= 0 && tokens[i + 1] === key;
  })) return source;
  return source.replace(/\s*$/, "") + (source.trim() ? "\n" : "") + publicKey.trim() + "\n";
}
// Scan only a directly attached private subnet, never more than /24 per interface.
export function kindleDiscoveryHosts(interfaces) {
  const hosts = new Set();
  for (const entries of Object.values(interfaces || {})) {
    for (const entry of entries || []) {
      if (entry.internal || !["IPv4", 4].includes(entry.family)) continue;
      try { kindleConnection({ host: entry.address }); } catch { continue; }
      const maskParts = String(entry.netmask).split(".").map(Number);
      if (maskParts.length !== 4 || maskParts.some(x => !Number.isInteger(x) || x < 0 || x > 255)) continue;
      const mask = maskParts.reduce((a, x) => (a << 8 | x) >>> 0, 0);
      const inverse = (~mask) >>> 0;
      if ((inverse & (inverse + 1)) !== 0) continue;
      const address = entry.address.split(".").reduce((a, x) => (a << 8 | Number(x)) >>> 0, 0);
      const effective = (mask | 0xffffff00) >>> 0, base = (address & effective) >>> 0;
      const count = (~effective) >>> 0;
      for (let i = 1; i < count && hosts.size < 512; i++) {
        const n = (base + i) >>> 0;
        if (n !== address) hosts.add([n >>> 24, n >>> 16 & 255, n >>> 8 & 255, n & 255].join("."));
      }
    }
  }
  return [...hosts];
}

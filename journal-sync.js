const fields = ["flow", "symptoms", "medicines"];
const lists = ["symptoms", "medicines"];
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const format = "moonmood-journal-v1";
const datePattern = /^\d{4}-\d{2}-\d{2}$/;

function unique(values) {
  return [...new Set(values)].sort();
}

function compareValue(first, second) {
  return JSON.stringify(first) === JSON.stringify(second);
}

function nextRevision(journal) {
  const sync = journal.sync ??= { clock: 0, revisions: {} };
  sync.clock = Math.max(Date.now(), sync.clock + 1);
  return `${String(sync.clock).padStart(16, "0")}:${crypto.randomUUID()}`;
}

export function deleteJournalEntry(journal, date) {
  const removed = nextRevision(journal);
  journal.sync.revisions[date] = { removed };
  delete journal.entries[date];
}

export function saveJournalEntry(journal, originalDate, date, entry) {
  if (originalDate && originalDate !== date) deleteJournalEntry(journal, originalDate);
  const stamp = nextRevision(journal);
  const previous = journal.entries[date];
  const revisions = journal.sync.revisions[date] ??= {};

  for (const field of fields) {
    if (!previous || !compareValue(previous[field], entry[field])) {
      revisions[field] = stamp;
    }
  }
  journal.entries[date] = entry;
}

export function mergeJournals(local, remote) {
  const journal = {
    entries: {},
    custom: {},
    sync: { clock: Math.max(local.sync?.clock ?? 0, remote?.sync?.clock ?? 0), revisions: {} },
  };
  for (const group of lists) {
    journal.custom[group] = unique([...local.custom[group], ...(remote?.custom[group] ?? [])]);
  }

  const localRevisions = local.sync?.revisions ?? {};
  const remoteRevisions = remote?.sync?.revisions ?? {};
  const days = unique([
    ...Object.keys(local.entries),
    ...Object.keys(remote?.entries ?? {}),
    ...Object.keys(localRevisions),
    ...Object.keys(remoteRevisions),
  ]);

  for (const date of days) {
    const aTags = localRevisions[date] ?? {};
    const bTags = remoteRevisions[date] ?? {};
    const removed = [aTags.removed ?? "", bTags.removed ?? ""].sort().at(-1);
    // A device must have seen the deletion before it can recreate this date.
    const a = !removed || aTags.removed === removed ? local.entries[date] : undefined;
    const b = !removed || bTags.removed === removed ? remote?.entries[date] : undefined;
    const tags = removed ? { removed } : {};
    const entry = { flow: 0, symptoms: [], medicines: [] };
    let hasEntry = false;

    for (const field of fields) {
      const left = a ? aTags[field] ?? "" : "";
      const right = b ? bTags[field] ?? "" : "";
      const newest = left > right ? left : right;
      if (removed && newest <= removed) continue;

      if (newest) tags[field] = newest;
      if (left > right) entry[field] = a[field];
      else if (right > left) entry[field] = b[field];
      else if (a && b) {
        entry[field] = field === "flow" ? Math.max(a.flow, b.flow) : unique([...a[field], ...b[field]]);
      } else if (a || b) entry[field] = (a ?? b)[field];
      else continue;
      hasEntry = true;
    }

    if (hasEntry) journal.entries[date] = entry;
    if (Object.keys(tags).length) journal.sync.revisions[date] = tags;
  }
  return journal;
}

function toBase64(bytes) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function fromBase64(encoded) {
  return Uint8Array.from(atob(encoded.replaceAll("-", "+").replaceAll("_", "/")), (character) => character.charCodeAt(0));
}

export function createPairingCode() {
  return `MM1-${toBase64(crypto.getRandomValues(new Uint8Array(32)))}`;
}

export function normalizePairingCode(value) {
  const code = value.replace(/\s/g, "");
  if (!/^MM1-[A-Za-z0-9_-]{43}$/.test(code) || toBase64(fromBase64(code.slice(4))) !== code.slice(4)) {
    throw new Error("配对码格式不正确。");
  }
  return code;
}

async function keysFor(code) {
  const material = await crypto.subtle.importKey("raw", fromBase64(code.slice(4)), "HKDF", false, ["deriveBits"]);
  const bytes = new Uint8Array(await crypto.subtle.deriveBits({
    name: "HKDF",
    hash: "SHA-256",
    salt: encoder.encode(format),
    info: encoder.encode("encryption-and-access"),
  }, material, 512));
  const key = await crypto.subtle.importKey("raw", bytes.slice(0, 32), "AES-GCM", false, ["encrypt", "decrypt"]);
  const access = Array.from(bytes.slice(32), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return { key, access };
}

function cipherOptions(iv) {
  return { name: "AES-GCM", iv, additionalData: encoder.encode(format) };
}

async function encrypt(key, journal) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt(cipherOptions(iv), key, encoder.encode(JSON.stringify(journal)));
  return `${toBase64(iv)}.${toBase64(new Uint8Array(data))}`;
}

async function decrypt(key, payload) {
  const [iv, data] = payload.split(".");
  const plain = await crypto.subtle.decrypt(cipherOptions(fromBase64(iv)), key, fromBase64(data));
  const journal = JSON.parse(decoder.decode(plain));
  if (!journal?.entries || !journal.sync?.revisions || !lists.every((group) => Array.isArray(journal.custom?.[group]))
    || !Object.entries(journal.entries).every(([date, entry]) => datePattern.test(date)
      && Number.isInteger(entry?.flow) && entry.flow >= 0 && entry.flow <= 4
      && lists.every((group) => Array.isArray(entry[group]) && entry[group].every((value) => typeof value === "string")))
    || !Object.keys(journal.sync.revisions).every((date) => datePattern.test(date))) {
    throw new Error("无法读取这份同步记录。");
  }
  return journal;
}

export function createJournalSync({ url, publicKey, readLocal, writeLocal, fetchRequest = fetch }) {
  async function rpc(name, args) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetchRequest(`${url}/rest/v1/rpc/${name}`, {
        method: "POST",
        cache: "no-store",
        credentials: "omit",
        headers: { apikey: publicKey, "Content-Type": "application/json" },
        body: JSON.stringify(args),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error("同步服务暂时不可用。");
      return await response.json();
    } finally {
      clearTimeout(timeout);
    }
  }

  return async function sync(code, { create = false } = {}) {
    const { key, access } = await keysFor(normalizePairingCode(code));
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const result = await rpc("moonmood_read", { p_access: access });
      if (!result && !create) throw new Error("找不到这个配对码，请在已连接的设备上重新复制。");
      const remote = result ? await decrypt(key, result.payload) : null;
      const local = readLocal();
      const merged = mergeJournals(local, remote);
      if (!compareValue(local, merged)) writeLocal(merged);
      if (remote && compareValue(remote, merged)) return;
      const payload = await encrypt(key, merged);
      if (payload.length > 1048576) throw new Error("记录已达到同步容量上限。");
      const saved = await rpc("moonmood_write", {
        p_access: access, p_revision: result?.revision ?? 0, p_payload: payload,
      });
      if (saved) return;
    }
    throw new Error("两台设备同时更新，请稍后重试。");
  };
}

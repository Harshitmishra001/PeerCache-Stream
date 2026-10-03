/* CacheRoom deliberately has no storage calls: all state lives in this page's memory. */
const MAX_MESSAGES = 20;
const CODE_LENGTH = 12;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const state = {
  role: null,
  name: "",
  roomCode: "",
  roomKey: null,
  messages: [],
  peers: new Map(),
  nextPeerId: 1,
  memberCount: 1,
  lastSignal: null
};

const $ = (id) => document.getElementById(id);
const notice = (text, error = false) => {
  $("notice").textContent = text;
  $("notice").style.color = error ? "var(--danger)" : "var(--accent)";
};

function randomCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (byte) => String(byte % 10)).join("");
}

function validCode(code) {
  return /^\d{12}$/.test(code);
}

async function deriveRoomKey(code) {
  const base = await crypto.subtle.importKey("raw", encoder.encode(code), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: encoder.encode("CacheRoom educational room key v1"), iterations: 120000, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

async function encryptMessage(message) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const bytes = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, state.roomKey, encoder.encode(JSON.stringify(message)));
  return { iv: Array.from(iv), data: Array.from(new Uint8Array(bytes)) };
}

async function decryptMessage(packet) {
  const bytes = await crypto.subtle.decrypt({ name: "AES-GCM", iv: new Uint8Array(packet.iv) }, state.roomKey, new Uint8Array(packet.data));
  return JSON.parse(decoder.decode(bytes));
}

function signalEncode(value) {
  return btoa(unescape(encodeURIComponent(JSON.stringify(value))));
}

function signalDecode(value) {
  return JSON.parse(decodeURIComponent(escape(atob(value.trim()))));
}

function showConnection() {
  $("setup").classList.add("hidden");
  $("connection").classList.remove("hidden");
  $("room-label").textContent = state.roomCode;
  $("member-count").textContent = state.memberCount;
  $("host-tools").classList.toggle("hidden", state.role !== "host");
  $("guest-tools").classList.toggle("hidden", state.role !== "guest");
  $("chat").classList.remove("hidden");
  renderMessages();
}

function addMessage(message) {
  state.messages.push(message);
  if (state.messages.length > MAX_MESSAGES) state.messages.splice(0, state.messages.length - MAX_MESSAGES);
  renderMessages();
}

function renderMessages() {
  const target = $("messages");
  target.replaceChildren();
  for (const message of state.messages) {
    const item = document.createElement("article");
    item.className = `message${message.sender === state.name ? " mine" : ""}`;
    const meta = document.createElement("div");
    meta.className = "message-meta";
    meta.textContent = `${message.sender} · ${new Date(message.time).toLocaleTimeString()}`;
    const body = document.createElement("div");
    body.className = "message-body";
    body.textContent = message.text;
    item.append(meta, body);
    target.append(item);
  }
  target.scrollTop = target.scrollHeight;
}

function updateMembers() {
  $("member-count").textContent = state.memberCount;
  $("transport").textContent = state.memberCount > 1 ? "Encrypted peer channel active" : "Waiting for a peer";
}

function clearMemory(reason = "Local chat memory cleared.") {
  state.messages.length = 0;
  state.roomKey = null;
  for (const peer of state.peers.values()) peer.connection.close();
  state.peers.clear();
  state.memberCount = 0;
  renderMessages();
  updateMembers();
  notice(reason);
}

function leave() {
  for (const peer of state.peers.values()) {
    if (peer.channel.readyState === "open") peer.channel.send(JSON.stringify({ type: "wipe", count: state.memberCount }));
  }
  clearMemory("Chat wiped for this participant.");
  $("connection").classList.add("hidden");
  $("setup").classList.remove("hidden");
  state.role = null;
  state.roomCode = "";
  $("room-code").value = "";
}

function createPeer() {
  const id = `peer-${state.nextPeerId++}`;
  const connection = new RTCPeerConnection({ iceServers: [] });
  const peer = { id, connection, channel: null, ready: false };
  state.peers.set(id, peer);
  connection.onconnectionstatechange = () => {
    if (["failed", "closed", "disconnected"].includes(connection.connectionState)) {
      clearMemory("A peer left or the connection became unsafe; all chat memory was wiped.");
    }
  };
  return peer;
}

function attachChannel(peer, channel) {
  peer.channel = channel;
  channel.onopen = () => {
    peer.ready = true;
    state.memberCount += 1;
    updateMembers();
    if (state.role === "host") channel.send(JSON.stringify({ type: "state", count: state.memberCount }));
  };
  channel.onclose = () => {
    clearMemory("A participant left; the shared chat was wiped.");
  };
  channel.onerror = () => clearMemory("The peer channel failed; the shared chat was wiped.");
  channel.onmessage = async (event) => {
    try {
      const packet = JSON.parse(event.data);
      if (packet.type === "state") {
        if (!Number.isInteger(packet.count) || packet.count < 1) throw new Error("invalid membership");
        state.memberCount = packet.count;
        updateMembers();
        return;
      }
      if (packet.type === "wipe") {
        clearMemory("The room membership changed; the shared chat was wiped.");
        return;
      }

      function waitForIceGathering(connection) {
        if (connection.iceGatheringState === "complete") return Promise.resolve();
        return new Promise((resolve) => {
          const check = () => {
            if (connection.iceGatheringState === "complete") {
              connection.removeEventListener("icegatheringstatechange", check);
              resolve();
            }
          };
          connection.addEventListener("icegatheringstatechange", check);
        });
      }
      if (packet.type !== "message") return;
      const message = await decryptMessage(packet.payload);
      addMessage(message);
      if (state.role === "host") {
        for (const other of state.peers.values()) {
          if (other !== peer && other.channel?.readyState === "open") other.channel.send(event.data);
        }
      }
    } catch {
      clearMemory("Invalid encrypted data received; the shared chat was wiped.");
    }
  };
}

async function createRoom() {
  state.name = $("name").value.trim() || "Anonymous";
  state.roomCode = randomCode();
  $("room-code").value = state.roomCode;
  state.role = "host";
  state.roomKey = await deriveRoomKey(state.roomCode);
  state.memberCount = 1;
  showConnection();
  notice("Room created. Share the room code and an offer with each participant.");
}

async function joinRoom() {
  state.name = $("name").value.trim() || "Anonymous";
  state.roomCode = $("room-code").value.trim();
  if (!validCode(state.roomCode)) return notice("Enter a valid 12-digit room code.", true);
  state.role = "guest";
  state.roomKey = await deriveRoomKey(state.roomCode);
  state.memberCount = 1;
  showConnection();
  notice("Paste a host offer to begin.");
}

async function makeOffer() {
  const peer = createPeer();
  attachChannel(peer, peer.connection.createDataChannel("chat", { ordered: true }));
  await peer.connection.setLocalDescription(await peer.connection.createOffer());
  await waitForIceGathering(peer.connection);
  $("signal-out").value = signalEncode({ roomCode: state.roomCode, type: "offer", description: peer.connection.localDescription });
  notice("Offer ready. Send it to one participant.");
}

async function acceptAnswer() {
  try {
    const signal = signalDecode($("signal-in").value);
    if (signal.roomCode !== state.roomCode || signal.type !== "answer") throw new Error("wrong answer");
    const peer = [...state.peers.values()].find((candidate) => candidate.connection.remoteDescription === null);
    if (!peer) throw new Error("no offer");
    await peer.connection.setRemoteDescription(signal.description);
    await waitForIceGathering(peer.connection);
    notice("Answer accepted. Waiting for the encrypted channel.");
  } catch {
    notice("That answer is invalid, belongs to another room, or has already been used.", true);
  }
}

async function makeAnswer() {
  try {
    const signal = signalDecode($("guest-in").value);
    if (signal.roomCode !== state.roomCode || signal.type !== "offer") throw new Error("wrong offer");
    const peer = createPeer();
    peer.connection.ondatachannel = (event) => attachChannel(peer, event.channel);
    await peer.connection.setRemoteDescription(signal.description);
    await peer.connection.setLocalDescription(await peer.connection.createAnswer());
    await waitForIceGathering(peer.connection);
    $("guest-out").value = signalEncode({ roomCode: state.roomCode, type: "answer", description: peer.connection.localDescription });
    notice("Answer ready. Send it back to the host.");
  } catch {
    notice("That offer is invalid or belongs to another room.", true);
  }
}

async function sendMessage(event) {
  event.preventDefault();
  const text = $("message").value.trim();
  if (!text || !state.roomKey) return;
  const message = { sender: state.name, text, time: Date.now() };
  const packet = JSON.stringify({ type: "message", payload: await encryptMessage(message) });
  addMessage(message);
  if (state.role === "host") {
    for (const peer of state.peers.values()) if (peer.channel?.readyState === "open") peer.channel.send(packet);
  } else {
    const peer = [...state.peers.values()].find((candidate) => candidate.channel?.readyState === "open");
    if (peer) peer.channel.send(packet);
  }
  $("message").value = "";
}

async function copyText(id) {
  const value = $(id).value;
  if (!value) return notice("Nothing to copy yet.", true);
  await navigator.clipboard.writeText(value);
  notice("Signal copied.");
}

$("create-room").onclick = createRoom;
$("join-room").onclick = joinRoom;
$("make-offer").onclick = makeOffer;
$("accept-answer").onclick = acceptAnswer;
$("make-answer").onclick = makeAnswer;
$("copy-signal").onclick = () => copyText("signal-out");
$("copy-answer").onclick = () => copyText("guest-out");
$("message-form").onsubmit = sendMessage;
$("leave").onclick = leave;
$("clear-everything").onclick = () => clearMemory("Local memory cleared.");
window.addEventListener("beforeunload", () => clearMemory("Page closed."));

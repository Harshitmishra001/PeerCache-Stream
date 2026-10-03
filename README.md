# CacheRoom

CacheRoom is a small research prototype for learning how browser cryptography and peer-to-peer messaging fit together. It is a static app: there is no application server, database, cookie, localStorage, IndexedDB, service worker, or analytics code.

## Run it

Serve this directory with any static web server and open it in two browser windows. WebRTC and Web Crypto generally require a secure context (`https://` or `http://localhost`), so a local server is preferable to opening `index.html` directly.

1. Create a room. The app generates a 12-digit code in memory.
2. Click **Create offer**, copy it to a participant through a trusted channel.
3. The participant enters the code, pastes the offer, creates an answer, and sends the answer back.
4. The host pastes the answer and accepts it.
5. Repeat the offer/answer exchange for more participants. The host relays encrypted data-channel packets to the other peers.

The code is an identifier and a password-derived application encryption key; it is not a rendezvous mechanism. Without a signaling service, peers must exchange WebRTC descriptions manually. This is intentional for the no-server research constraint.

## What is ephemeral

Messages are kept in a JavaScript array capped at 20 entries. The app does not intentionally persist chat state. Leaving, a data-channel close/error, a failed connection, invalid encrypted data, or a membership change clears messages, closes connections, and drops the room key from application state.

This is best-effort deletion, not a forensic guarantee. Browsers, operating systems, extensions, screenshots, crash dumps, swap files, and network observers can retain data outside the app's control. A browser cannot guarantee that `beforeunload` runs, so an abrupt process kill can only be handled by the remaining peers when they notice the connection loss.

## Cryptography notes

- WebRTC data channels already use DTLS encryption in the browser.
- CacheRoom adds AES-256-GCM encryption to message payloads.
- The AES key is derived with PBKDF2-SHA-256 from the room code. This is educational, not a production protocol: a 12-digit code is not a high-entropy secret.
- For a real application, use a reviewed end-to-end protocol with authenticated identity keys, forward secrecy, replay protection, and a proper signaling/rendezvous service.

## Counter limitation

The member count is host-authoritative in this prototype. A simple increment/decrement flag is not a distributed-consensus mechanism: simultaneous joins, duplicate events, crashes, and malicious clients can make it wrong. Therefore every peer connection close or protocol inconsistency wipes local state instead of trying to recover a possibly divergent chat history.

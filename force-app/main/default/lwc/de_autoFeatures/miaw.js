/**
 * MIAW (Messaging for In-App & Web) custom-client — the "live sales specialist" bridge.
 *
 * Runs entirely in the browser (the SSE stream needs an Authorization header, which
 * EventSource can't set and Apex can't stream — so this must be client-side).
 *
 * Flow (SCRT2 v2 REST):
 *   1. POST .../authorization/unauthenticated/access-token -> { accessToken, lastEventId }
 *   2. POST .../conversation                               -> create conversation (201/409 ok)
 *   3. GET  .../eventrouter/v1/sse (fetch stream)          -> live events (specialist msgs, routing)
 *   4. POST .../conversation/{id}/message                  -> send a customer message (202)
 *
 * NOTE: the SSE `X-Org-Id` header MUST be the 15-char org id and match the token's org.
 */

// ---- Config for this org's In-App & Web messaging deployment (set before deploying) ----
// SCRT2 host mirrors My Domain (…my.salesforce.com -> …my.salesforce-scrt.com).
// esDeveloperName is the Embedded Service deployment API name; the channel routes
// via the Sightline_Messaging_Omni_Flow to the Sightline_Messaging_Queue queue (create these in your org).
export const MIAW_SCRT2_URL = 'https://REPLACE_ME.my.salesforce-scrt.com';
export const MIAW_ORG_ID = 'REPLACE_ME'; // 15-char org id (must match token org)
export const MIAW_ES_DEVELOPER_NAME = 'de_Auto_Messaging_API';

const API_BASE = `${MIAW_SCRT2_URL}/iamessage/api/v2`;

export function uuid() {
    if (window.crypto && window.crypto.randomUUID) {
        return window.crypto.randomUUID();
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
    });
}

export async function getUnauthToken() {
    const res = await fetch(`${API_BASE}/authorization/unauthenticated/access-token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            orgId: MIAW_ORG_ID,
            esDeveloperName: MIAW_ES_DEVELOPER_NAME,
            capabilitiesVersion: '1',
            platform: 'Web'
        })
    });
    if (!res.ok) {
        throw new Error(`MIAW token failed (${res.status}): ${await res.text()}`);
    }
    const data = await res.json();
    return { accessToken: data.accessToken, lastEventId: String(data.lastEventId || '') };
}

export async function createConversation(token, conversationId) {
    const res = await fetch(`${API_BASE}/conversation`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId, esDeveloperName: MIAW_ES_DEVELOPER_NAME })
    });
    // 201 created; 409 = already exists — both are fine to proceed.
    if (!res.ok && res.status !== 409) {
        throw new Error(`MIAW create conversation failed (${res.status}): ${await res.text()}`);
    }
}

export async function sendText(token, conversationId, text, messageId) {
    const res = await fetch(`${API_BASE}/conversation/${conversationId}/message`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            message: {
                id: messageId || uuid(),
                messageType: 'StaticContentMessage',
                staticContent: { formatType: 'Text', text }
            },
            esDeveloperName: MIAW_ES_DEVELOPER_NAME
        })
    });
    if (!res.ok) {
        throw new Error(`MIAW send message failed (${res.status}): ${await res.text()}`);
    }
}

/**
 * Upload a customer image into the conversation so it renders inline in the
 * specialist's Service Console (verified live: returns 202 with conversationEntries).
 *
 * Endpoint + exact contract per the MIAW v2 OpenAPI `sendFile` operation:
 *   POST /iamessage/api/v2/conversation/{conversationId}/file
 *   multipart/form-data, TWO required parts (browser sets the boundary):
 *     - messageEntry : Content-Type application/json. Schema `SendFilesRequestApi`:
 *         { message: { id, fileId, text? }, esDeveloperName, isNewMessagingSession }
 *       NOTE: this is NOT the StaticContentMessage/formatType:Attachments shape used
 *       by the text endpoint — there is no `attachments` array. `id` is the entry id,
 *       `fileId` is a client-generated UUID for the file (need not match a part name).
 *     - fileData : Content-Type application/octet-stream (NOT the image MIME type —
 *       the server infers the real type from the bytes/filename). filename required.
 *
 * A Blob's own `type` becomes the part's Content-Type, so we force octet-stream by
 * re-wrapping the bytes. Failures are non-fatal — the caller falls back to a text note.
 * @param {Blob} blob  the image bytes (e.g. a captured JPEG frame)
 */
export async function sendImage(token, conversationId, blob, fileName) {
    const name = fileName || 'capture.jpg';
    const form = new FormData();
    // messageEntry — the JSON envelope. FormData sends a string field without a
    // Content-Type, so wrap it in an application/json Blob to satisfy the encoding.
    const entry = {
        message: { id: uuid(), fileId: uuid(), text: 'Photo shared from the live camera' },
        esDeveloperName: MIAW_ES_DEVELOPER_NAME,
        isNewMessagingSession: false
    };
    form.append('messageEntry', new Blob([JSON.stringify(entry)], { type: 'application/json' }));
    // fileData — MUST be application/octet-stream; re-wrap so the part header is right.
    form.append('fileData', new Blob([blob], { type: 'application/octet-stream' }), name);
    const res = await fetch(`${API_BASE}/conversation/${conversationId}/file`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` }, // let the browser set the multipart boundary
        body: form
    });
    if (!res.ok) {
        throw new Error(`MIAW attachment failed (${res.status}): ${await res.text().catch(() => '')}`);
    }
}

/** Opens the SSE stream via fetch (so we can set the Authorization + X-Org-Id headers). */
export async function openEventStream(token, lastEventId) {
    const headers = {
        Authorization: `Bearer ${token}`,
        'X-Org-Id': MIAW_ORG_ID,
        Accept: 'text/event-stream'
    };
    if (lastEventId) {
        headers['Last-Event-Id'] = lastEventId;
    }
    const res = await fetch(`${MIAW_SCRT2_URL}/eventrouter/v1/sse`, { headers });
    if (!res.ok || !res.body) {
        throw new Error(`MIAW SSE failed (${res.status}): ${await res.text().catch(() => '')}`);
    }
    return res;
}

/**
 * Reads a fetch SSE Response and calls onEvent({event, data, id}) per event.
 * Returns a function that stops reading. Loops until the stream ends or stop() is called.
 */
export async function readSse(response, onEvent, shouldContinue) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    // eslint-disable-next-line no-constant-condition
    while (true) {
        if (shouldContinue && !shouldContinue()) {
            try {
                await reader.cancel();
            } catch (e) {
                /* ignore */
            }
            return;
        }
        const { value, done } = await reader.read();
        if (done) {
            return;
        }
        buffer += decoder.decode(value, { stream: true });
        // SSE frames are separated by a blank line.
        let sep;
        while ((sep = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);
            let eventName = 'message';
            let id = '';
            const dataLines = [];
            frame.split('\n').forEach((line) => {
                if (line.startsWith('event:')) {
                    eventName = line.slice(6).trim();
                } else if (line.startsWith('data:')) {
                    dataLines.push(line.slice(5).trim());
                } else if (line.startsWith('id:')) {
                    id = line.slice(3).trim();
                }
            });
            if (!dataLines.length) {
                continue;
            }
            let data = {};
            try {
                data = JSON.parse(dataLines.join('\n'));
            } catch (e) {
                data = {};
            }
            onEvent({ event: eventName, data, id });
        }
    }
}

/**
 * Distils a raw MIAW SSE event into something renderable.
 * Returns { kind, text?, senderName?, on? } where kind is
 * 'specialistMessage' | 'status' | 'typing' | 'ignore'.
 */
export function parseMiawEvent(eventName, data) {
    const entry = (data && data.conversationEntry) || {};
    let payload = {};
    try {
        payload = typeof entry.entryPayload === 'string' ? JSON.parse(entry.entryPayload) : entry.entryPayload || {};
    } catch (e) {
        payload = {};
    }
    const sender = entry.sender || {};
    const senderRole = String(sender.role || '');
    const senderName = String(entry.senderDisplayName || 'Specialist');

    switch (eventName) {
        case 'CONVERSATION_MESSAGE': {
            // Ignore the customer's own echoed messages.
            if (senderRole === 'EndUser') {
                return { kind: 'ignore' };
            }
            const am = payload.abstractMessage || {};
            const sc = am.staticContent || {};
            const text = String(sc.text || '');
            if (!text) {
                return { kind: 'ignore' };
            }
            return { kind: 'specialistMessage', text, senderName };
        }
        case 'CONVERSATION_ROUTING_RESULT':
            return { kind: 'status', text: 'Connecting you to a live specialist…' };
        case 'CONVERSATION_SESSION_OWNER_CHANGED': {
            const newOwner = String(payload.newOwnerType || '');
            if (newOwner === 'Agent') {
                return { kind: 'status', text: 'A specialist has joined the chat 👩‍💼' };
            }
            if (newOwner === 'Queue') {
                return { kind: 'status', text: "You're in the queue — a specialist will be with you shortly…" };
            }
            return { kind: 'ignore' };
        }
        case 'CONVERSATION_TYPING_STARTED_INDICATOR':
            return { kind: 'typing', on: true };
        case 'CONVERSATION_TYPING_STOPPED_INDICATOR':
            return { kind: 'typing', on: false };
        default:
            return { kind: 'ignore' };
    }
}

import { LightningElement, track } from 'lwc';
import getProducts from '@salesforce/apex/de_ProductService.getProducts';
import startSession from '@salesforce/apex/de_AgentforceService.startSession';
import sendMessage from '@salesforce/apex/de_AgentforceService.sendMessage';
import analyzeFrame from '@salesforce/apex/de_VideoReasoningController.analyzeFrame';
import analyzeFrameWithModel from '@salesforce/apex/de_VideoReasoningController.analyzeFrameWithModel';
import {
    getUnauthToken,
    createConversation,
    sendText as miawSendText,
    sendImage as miawSendImage,
    openEventStream,
    readSse,
    parseMiawEvent,
    uuid
} from './miaw';

const FRAME_MAX_DIM = 640;
// gemini-2.5-flash has proper 2D object detection; the image model does not.
const LOCATE_MODEL = 'gemini-2.5-flash';
// Intent phrases that mean "point to / mark this on screen".
const LOCATE_RE = /\b(where('?s)?|show me|point (to|out)?|locate|find|mark|which (one|part|button|knob|slot))\b/i;
// Intent phrases that mean "log a case / hand me to a human specialist".
const ESCALATE_RE =
    /\b(create|open|log|raise|file)\b.{0,20}\b(case|ticket|complaint)\b|\b(talk|speak|connect|chat)\b.{0,20}\b(human|expert|specialist|agent|person|someone|representative|rep)\b|\b(real|live)\s+(person|human|agent)\b|\bescalat/i;
// Pull a Salesforce case number (8 digits) out of the agent's reply, if present.
const CASE_NUM_RE = /\b(\d{7,10})\b/;
const MARKER_MS = 6000; // how long the frozen "marked" snapshot stays up
// Typical time from Start → live view (agent seed turn dominates). Used to pace the
// connecting checklist so items check off across the whole wait, not all at the end.
const ESTIMATED_CONNECT_MS = 45000;
const CONNECT_MSGS = [
    'Waking up the troubleshooting assistant…',
    'Loading your product guide…',
    'Turning on the camera…',
    'Getting the microphone ready…',
    'Almost there…'
];

export default class De_videoTroubleshoot extends LightningElement {
    @track screen = 'picker'; // 'picker' | 'connecting' | 'live' | 'specialist'
    @track products = [];
    @track selectedId = '';
    @track productName = '';
    @track status = '';
    @track connectMsg = CONNECT_MSGS[0];
    @track thinking = false;
    @track speaking = false; // true while the agent/specialist reply is being read aloud
    @track recording = false; // true while the push-to-talk mic button is held
    @track checklist = []; // live "what's loaded" ticks on the connecting screen
    @track mirror = false; // true only for a front/user-facing camera
    @track messages = []; // {id, role, text, cls}
    @track marker = { visible: false, leftPct: 0, topPct: 0, wPct: 0, hPct: 0, label: '' };
    @track snapshot = { visible: false, src: '' };

    // ---- Specialist (MIAW human handoff) state ----
    @track specMessages = []; // {id, role, text, cls}
    @track specStatus = 'Connecting you to a live specialist…';
    @track specTyping = false;
    @track textDraft = '';
    @track caseNumber = '';
    @track lastIssue = '';
    // Photo-capture preview overlay: open = aiming with live camera; still set = a
    // frozen shot awaiting the user's Send/Retake confirmation.
    @track capture = { open: false, still: '' };
    _captureB64 = '';

    sessionId;
    seq = 2; // startSession consumes sequenceId 1 (the seed turn)
    stream;
    recognition;
    videoEl;
    canvasEl;
    liveInit = false;
    _mid = 0;
    _ttsActive = false;
    _ttsWatch = null;
    _ttsCap = null; // hard timeout so a hung speech engine can't freeze the mic
    _ttsStarted = false; // set once we've CONFIRMED audio actually began (onstart/speaking)
    _ttsStartDeadline = 0; // grace window for audio to start before we assume it failed
    _pttTranscript = ''; // accumulates the transcript while the mic button is held
    _recognizer = null; // ONE reused SpeechRecognition (avoids re-prompting the mic each press)
    _pttState = 'idle'; // 'idle' | 'recording' | 'stopping'
    _connIdx = 0;
    _connTimer = null;
    _snapTimer = null;
    _progressTimers = [];
    // MIAW
    _miawToken = null;
    _miawConvId = null;
    _miawAlive = false;
    _escalating = false;
    _specInit = false;

    connectedCallback() {
        this.loadProducts();
    }

    async loadProducts() {
        try {
            this.products = await getProducts();
            this.decorateProducts();
            if (!this.products.length) {
                this.status = 'No products found.';
            }
        } catch (error) {
            this.status = 'Could not load products: ' + this.errMsg(error);
        }
    }

    renderedCallback() {
        // Attach the (already-acquired) camera stream once the live DOM exists.
        if (this.screen === 'live' && !this.liveInit) {
            this.videoEl = this.template.querySelector('video');
            this.canvasEl = this.template.querySelector('canvas');
            if (this.videoEl && this.stream) {
                this.liveInit = true;
                this.videoEl.srcObject = this.stream;
                // eslint-disable-next-line @lwc/lwc/no-async-operation
                this.videoEl.play().catch(() => {});
                // Mic is push-to-talk now — the user holds the button to speak.
            }
        }
        // Specialist mode keeps the camera alive (hidden) so the capture button works.
        if (this.screen === 'specialist' && !this._specInit) {
            this.videoEl = this.template.querySelector('video');
            this.canvasEl = this.template.querySelector('canvas');
            this._specInit = true;
            if (this.videoEl && this.stream) {
                this.videoEl.srcObject = this.stream;
                // eslint-disable-next-line @lwc/lwc/no-async-operation
                this.videoEl.play().catch(() => {});
            }
            // Mic is push-to-talk here too (see the hold-to-talk button).
        }
        // Live preview inside the capture overlay (aiming, before the still is frozen).
        if (this.screen === 'specialist' && this.capture.open && !this.capture.still) {
            const pv = this.template.querySelector('.vt-cap-video');
            if (pv && this.stream && pv.srcObject !== this.stream) {
                pv.srcObject = this.stream;
                // eslint-disable-next-line @lwc/lwc/no-async-operation
                pv.play().catch(() => {});
            }
        }
    }

    disconnectedCallback() {
        this.teardown();
    }

    // ---- Picker ----
    handleSelectProduct(event) {
        const id = event.currentTarget.dataset.id;
        this.selectedId = this.selectedId === id ? '' : id;
        this.productName = event.currentTarget.dataset.name;
        this.decorateProducts();
    }

    // Fixed bottom "Start": connect to the agent first (progress indicator),
    // then reveal the video screen.
    async handleStart() {
        if (!this.selectedId || this.thinking) {
            return;
        }
        // Prime speech + acquire the camera synchronously inside this tap so iOS
        // allows later TTS and grants camera access.
        this.primeSpeech();
        this.screen = 'connecting';
        this.status = 'Connecting to the troubleshooting agent…';
        this.thinking = true;
        this.initChecklist();
        this.startConnectAnimation();
        // eslint-disable-next-line no-console
        console.log('%c[VideoTroubleshoot] ▶️ START tapped for:', 'color:#0af;font-weight:bold', this.productName);

        // Camera acquisition runs in parallel with the (slower) agent start; tick its
        // checklist item the moment the stream is ready.
        const camPromise = this.acquireCamera().then(() => this.tickStep('camera'));
        // Progressively check off the quick items while the agent seed turn runs.
        this.startChecklistProgress();
        try {
            // The seed turn runs the agent + prompt-template LLM (can be slow the first
            // time), and the Apex callout itself allows up to 120s — so wait ~115s.
            const res = await this.withTimeout(startSession({ productName: this.productName }), 115000, 'The session');
            await camPromise; // ensure the stream is ready before showing video
            if (res && res.success) {
                this.sessionId = res.sessionId;
                this.seq = res.nextSequenceId || 2;
                const greeting = this.sanitizeReply(res.text);
                this.addMessage('agent', greeting);
                this.status = '';
                // Seed turn is back — the assistant is truly ready. Make sure the
                // earlier quick items are checked (in case the call returned fast),
                // then land the final "assistant" tick and hold a beat so the user
                // sees the checklist complete before the live view appears.
                this.clearChecklistProgress();
                this.tickStep('mic');
                this.tickStep('guide');
                await this.tickStepDelayed('agent', 500);
                // eslint-disable-next-line no-console
                console.log(
                    '%c[VideoTroubleshoot] ✅ SESSION STARTED sessionId=' + this.sessionId + ' nextSeq=' + this.seq +
                        '\n  🤖 GROUNDED GREETING:',
                    'color:#0f0;font-weight:bold',
                    res.text
                );
                this.stopConnectAnimation();
                this.screen = 'live'; // renderedCallback attaches stream + starts mic
                this.speak(greeting);
            } else {
                // eslint-disable-next-line no-console
                console.error('[VideoTroubleshoot] Agent session error:', res ? res.error : 'unknown');
                this.status = 'Agent error: ' + (res ? res.error : 'unknown');
                this.stopConnectAnimation();
                this.screen = 'picker';
            }
        } catch (e) {
            // eslint-disable-next-line no-console
            console.error('[VideoTroubleshoot] Could not start:', this.errMsg(e), e);
            this.status = 'Could not start: ' + this.errMsg(e);
            this.stopConnectAnimation();
            this.screen = 'picker';
        } finally {
            this.thinking = false;
        }
    }

    // Live "what's loaded" checklist shown under the orb while connecting.
    // Order matters: quick items first, and the SLOW real one — waking the
    // assistant (the up-to-115s seed turn) — LAST, so it keeps spinning while
    // the earlier items visibly check off and progress feels continuous.
    initChecklist() {
        this.checklist = [
            { key: 'camera', label: 'Turning on the camera', done: false },
            { key: 'mic', label: 'Getting the microphone ready', done: false },
            { key: 'guide', label: 'Loading your product guide', done: false },
            { key: 'agent', label: 'Waking up the troubleshooting assistant', done: false }
        ].map((i) => this.decorateStep(i));
    }

    tickStep(key) {
        this.checklist = this.checklist.map((i) =>
            i.key === key ? this.decorateStep({ ...i, done: true }) : i
        );
    }

    /** Tick a step, then pause so the next one checks off as a visible cascade. */
    tickStepDelayed(key, ms) {
        this.tickStep(key);
        // eslint-disable-next-line @lwc/lwc/no-async-operation
        return new Promise((r) => setTimeout(r, ms));
    }

    /**
     * Check off the quick items on a short timeline WHILE the long agent seed
     * turn is still running, so the user sees steady progress instead of three
     * items spinning the whole time. Camera is ticked separately by its real
     * promise; the assistant item is left spinning until startSession resolves.
     */
    startChecklistProgress() {
        // Divide the estimated connect window into thirds: mic ~1/3 in, guide ~2/3
        // in, and the assistant lands on real completion (~end of the window).
        const t = ESTIMATED_CONNECT_MS;
        this._progressTimers = [
            // eslint-disable-next-line @lwc/lwc/no-async-operation
            setTimeout(() => this.tickStep('mic'), Math.round(t * 0.33)),
            // eslint-disable-next-line @lwc/lwc/no-async-operation
            setTimeout(() => this.tickStep('guide'), Math.round(t * 0.66))
        ];
    }

    clearChecklistProgress() {
        (this._progressTimers || []).forEach((t) => clearTimeout(t));
        this._progressTimers = [];
    }

    decorateStep(i) {
        return {
            ...i,
            icon: i.done ? '✓' : '',
            cls: i.done ? 'vt-check vt-check-done' : 'vt-check'
        };
    }

    startConnectAnimation() {
        this._connIdx = 0;
        this.connectMsg = CONNECT_MSGS[0];
        // Advance slowly (agent start can take a while); hold on the last message
        // rather than looping back to the first.
        // eslint-disable-next-line @lwc/lwc/no-async-operation
        this._connTimer = setInterval(() => {
            if (this._connIdx < CONNECT_MSGS.length - 1) {
                this._connIdx += 1;
                this.connectMsg = CONNECT_MSGS[this._connIdx];
            }
        }, 3500);
    }

    stopConnectAnimation() {
        if (this._connTimer) {
            clearInterval(this._connTimer);
            this._connTimer = null;
        }
        this.clearChecklistProgress();
    }

    async acquireCamera() {
        this.stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: { ideal: 'environment' } },
            audio: false
        });
        const track = this.stream.getVideoTracks()[0];
        const facing = track && track.getSettings ? track.getSettings().facingMode : undefined;
        this.mirror = facing !== 'environment';
        // eslint-disable-next-line no-console
        console.log(
            '%c[VideoTroubleshoot] 🎥 CAMERA:',
            'color:#0af',
            'facingMode=' + (facing || '(none/desktop)') + ', mirrored=' + this.mirror
        );
    }

    // ---- User voice turn -> (vision context) -> agent -> speech ----
    async handleUserTurn(userText) {
        if (!userText || this.thinking || !this.sessionId) {
            return;
        }
        this.thinking = true;
        this.addMessage('user', userText);
        this.clearMarker();
        // eslint-disable-next-line no-console
        console.log('%c[VideoTroubleshoot] 🗣️ USER SAID:', 'color:#0af;font-weight:bold', userText);

        // "Create a case" / "talk to an expert" → let the agent log the case this turn,
        // then hand off to a live specialist over MIAW.
        const escalate = ESCALATE_RE.test(userText);
        if (escalate) {
            this._escalating = true;
            this.lastIssue = userText;
            // eslint-disable-next-line no-console
            console.log('%c[VideoTroubleshoot] 🚨 ESCALATION intent detected', 'color:#f55;font-weight:bold');
        }

        // Capture ONE frame for this turn and reuse it for vision + marking.
        const frame = this.captureBase64();
        if (!escalate && LOCATE_RE.test(userText) && frame) {
            this.locateItem(userText, frame); // fire-and-forget; non-blocking
        }

        try {
            // Escalation turn: no camera context — just let the agent log the case + confirm.
            if (escalate) {
                const res = await this.withTimeout(
                    sendMessage({ sessionId: this.sessionId, sequenceId: this.seq, text: userText }),
                    115000,
                    'The agent'
                );
                if (res && res.success) {
                    this.seq = res.nextSequenceId || this.seq + 1;
                    const reply = this.sanitizeReply(res.text);
                    this.addMessage('agent', reply);
                    this.speak(reply);
                    const m = (res.text || '').match(CASE_NUM_RE);
                    if (m) {
                        this.caseNumber = m[1];
                    }
                }
                // Hand off to the live specialist regardless of the exact agent phrasing.
                this.enterSpecialist();
                return;
            }
            const visionContext = await this.describeFrame(frame);
            let turn;
            if (visionContext) {
                turn =
                    '[LIVE CAMERA] Right now, through your live camera, you can see: ' +
                    visionContext +
                    '. Use this to guide the user. The user says: "' +
                    userText +
                    '".';
            } else {
                turn =
                    '[LIVE CAMERA] Your live camera is on but nothing clear is in view right now — ' +
                    'if you need to see a part, ask the user to point the camera at it. ' +
                    'The user says: "' +
                    userText +
                    '".';
            }
            // eslint-disable-next-line no-console
            console.log('%c[VideoTroubleshoot] 📤 TURN SENT (seq ' + this.seq + '):', 'color:#fa0;font-weight:bold', turn);
            const res = await this.withTimeout(
                sendMessage({ sessionId: this.sessionId, sequenceId: this.seq, text: turn }),
                115000,
                'The agent'
            );
            if (res && res.success) {
                this.seq = res.nextSequenceId || this.seq + 1;
                const reply = this.sanitizeReply(res.text);
                this.addMessage('agent', reply);
                // eslint-disable-next-line no-console
                console.log('%c[VideoTroubleshoot] 🤖 AGENT REPLY:', 'color:#0f0;font-weight:bold', res.text);
                this.speak(reply);
            } else {
                // eslint-disable-next-line no-console
                console.error('[VideoTroubleshoot] Agent error:', res ? res.error : 'unknown');
                this.status = 'Agent error: ' + (res ? res.error : 'unknown');
            }
        } catch (e) {
            // eslint-disable-next-line no-console
            console.error('[VideoTroubleshoot] Turn failed:', this.errMsg(e), e);
            this.status = 'Turn failed: ' + this.errMsg(e);
        } finally {
            this.thinking = false;
        }
    }

    /** One short Gemini pass to give the agent "eyes"; failures are non-fatal. */
    async describeFrame(frame) {
        const b64 = frame || this.captureBase64();
        if (!b64) {
            // eslint-disable-next-line no-console
            console.warn('[VideoTroubleshoot] 📷 No frame captured (video not ready).');
            return '';
        }
        // eslint-disable-next-line no-console
        console.log('%c[VideoTroubleshoot] 📷 FRAME CAPTURED:', 'color:#aaa', b64.length + ' base64 chars → Gemini vision…');
        try {
            const res = await analyzeFrame({
                base64Image: b64,
                mimeType: 'image/jpeg',
                prompt:
                    'You are the eyes of a product support agent looking through a live phone camera. ' +
                    'In one or two short sentences, describe what product or part is visible and its state ' +
                    '(e.g. buttons, lights, dials, connections, any error shown, whether a lid/plug is open or closed). ' +
                    'Be concrete and factual. If the view is too blurry or empty to tell, reply exactly "unclear".'
            });
            const t = res && res.success ? (res.text || '').trim() : '';
            // eslint-disable-next-line no-console
            console.log('%c[VideoTroubleshoot] 👁️ GEMINI SEES:', 'color:#c0f;font-weight:bold', t || '(empty)');
            return t && t.toLowerCase() !== 'unclear' ? t : '';
        } catch (e) {
            // eslint-disable-next-line no-console
            console.error('[VideoTroubleshoot] Vision call failed:', e);
            return '';
        }
    }

    /**
     * Ask Gemini for the on-screen location of the item the user referenced, then
     * FREEZE that exact frame and drop the pin on it (so the pin matches what was
     * analysed — the live video keeps moving, a frozen frame does not).
     */
    async locateItem(userText, frame) {
        if (!frame) {
            return;
        }
        try {
            // Use Gemini's official 2D-detection format (box_2d, 0-1000) on the
            // detection-capable model — far more accurate than a free-form point.
            const res = await analyzeFrameWithModel({
                base64Image: frame,
                mimeType: 'image/jpeg',
                model: LOCATE_MODEL,
                prompt:
                    'Detect the single item the user wants pointed out. The user asked: "' +
                    userText +
                    '". Return ONLY a JSON array (no markdown) of at most one object with keys ' +
                    '"box_2d" (an array [ymin, xmin, ymax, xmax] as integers from 0 to 1000, measured ' +
                    'from the top-left of the image) and "label" (a short name). ' +
                    'Pick the most relevant, tightly-cropped item. If it is not clearly visible, return [].'
            });
            const raw = res && res.success ? (res.text || '') : '';
            const box = this.parseBox(raw);
            // eslint-disable-next-line no-console
            console.log('%c[VideoTroubleshoot] 📍 LOCATE:', 'color:#ff0', raw.replace(/\s+/g, ' ').slice(0, 200));
            if (!box) {
                return;
            }
            const rect = this.boxToContainer(box);
            // Freeze the analysed frame so the box lands exactly where Gemini looked.
            this.snapshot = { visible: true, src: 'data:image/jpeg;base64,' + frame };
            this.marker = {
                visible: true,
                leftPct: rect.leftPct,
                topPct: rect.topPct,
                wPct: rect.wPct,
                hPct: rect.hPct,
                label: box.label || 'Here'
            };
            if (this._snapTimer) {
                clearTimeout(this._snapTimer);
            }
            // eslint-disable-next-line @lwc/lwc/no-async-operation
            this._snapTimer = setTimeout(() => this.clearMarker(), MARKER_MS);
        } catch (e) {
            // eslint-disable-next-line no-console
            console.warn('[VideoTroubleshoot] locate failed:', e);
        }
    }

    /** Pull the first {box_2d,label} out of Gemini's response (array or single object). */
    parseBox(raw) {
        const txt = (raw || '').replace(/```json|```/gi, '').trim();
        let parsed;
        try {
            const s = txt.indexOf('[');
            const e = txt.lastIndexOf(']');
            if (s >= 0 && e > s) {
                parsed = JSON.parse(txt.substring(s, e + 1));
            } else {
                const os = txt.indexOf('{');
                const oe = txt.lastIndexOf('}');
                if (os < 0 || oe < 0) {
                    return null;
                }
                parsed = [JSON.parse(txt.substring(os, oe + 1))];
            }
        } catch (e) {
            return null;
        }
        const first = Array.isArray(parsed) ? parsed[0] : parsed;
        if (!first || !Array.isArray(first.box_2d) || first.box_2d.length < 4) {
            return null;
        }
        return { box_2d: first.box_2d, label: first.label };
    }

    /** box_2d [ymin,xmin,ymax,xmax] (0-1000) -> container-% rect (cover + mirror aware). */
    boxToContainer(box) {
        const b = box.box_2d;
        const fy1 = Math.min(1, Math.max(0, b[0] / 1000));
        const fx1 = Math.min(1, Math.max(0, b[1] / 1000));
        const fy2 = Math.min(1, Math.max(0, b[2] / 1000));
        const fx2 = Math.min(1, Math.max(0, b[3] / 1000));
        const p1 = this.mapFrameToContainer(fx1, fy1);
        const p2 = this.mapFrameToContainer(fx2, fy2);
        let leftPct = Math.min(p1.xPct, p2.xPct);
        let topPct = Math.min(p1.yPct, p2.yPct);
        let wPct = Math.abs(p2.xPct - p1.xPct);
        let hPct = Math.abs(p2.yPct - p1.yPct);
        // Guard against a degenerate (point-like) box so the highlight stays visible.
        if (wPct < 8) {
            leftPct = Math.max(0, leftPct - (8 - wPct) / 2);
            wPct = 8;
        }
        if (hPct < 8) {
            topPct = Math.max(0, topPct - (8 - hPct) / 2);
            hPct = 8;
        }
        return { leftPct, topPct, wPct, hPct };
    }

    /**
     * Convert frame-space (0..1) coords to container-percentage, accounting for
     * object-fit: cover cropping and front-camera mirroring. The frozen snapshot
     * uses the same cover/mirror rules, so the pin lines up with the image.
     */
    mapFrameToContainer(fx, fy) {
        const v = this.videoEl;
        const cw = v ? v.clientWidth : 0;
        const ch = v ? v.clientHeight : 0;
        const vw = v ? v.videoWidth : 0;
        const vh = v ? v.videoHeight : 0;
        // Mirror the X for a front camera (both video + snapshot are shown mirrored).
        const px = this.mirror ? 1 - fx : fx;
        if (!cw || !ch || !vw || !vh) {
            return { xPct: Math.round(px * 100), yPct: Math.round(fy * 100) };
        }
        const scale = Math.max(cw / vw, ch / vh); // cover
        const dispW = vw * scale;
        const dispH = vh * scale;
        const offX = (cw - dispW) / 2;
        const offY = (ch - dispH) / 2;
        const containerX = px * dispW + offX;
        const containerY = fy * dispH + offY;
        return {
            xPct: Math.round((containerX / cw) * 100),
            yPct: Math.round((containerY / ch) * 100)
        };
    }

    handleDismissSnapshot() {
        this.clearMarker();
    }

    clearMarker() {
        if (this._snapTimer) {
            clearTimeout(this._snapTimer);
            this._snapTimer = null;
        }
        if (this.marker.visible) {
            this.marker = { visible: false, leftPct: 0, topPct: 0, wPct: 0, hPct: 0, label: '' };
        }
        if (this.snapshot.visible) {
            this.snapshot = { visible: false, src: '' };
        }
    }

    captureBase64() {
        const v = this.videoEl;
        if (!v || !v.videoWidth) {
            return null;
        }
        const scale = Math.min(1, FRAME_MAX_DIM / Math.max(v.videoWidth, v.videoHeight));
        const w = Math.round(v.videoWidth * scale);
        const h = Math.round(v.videoHeight * scale);
        const c = this.canvasEl;
        c.width = w;
        c.height = h;
        c.getContext('2d').drawImage(v, 0, 0, w, h);
        return c.toDataURL('image/jpeg', 0.7).split(',')[1];
    }

    // ---- Conversation transcript ----
    addMessage(role, text) {
        if (!text) {
            return;
        }
        this.messages = [
            ...this.messages,
            { id: this._mid++, role, text, cls: role === 'user' ? 'vt-msg vt-msg-user' : 'vt-msg vt-msg-agent' }
        ].slice(-8);
        // Keep the newest message in view.
        // eslint-disable-next-line @lwc/lwc/no-async-operation
        Promise.resolve().then(() => {
            const box = this.template.querySelector('.vt-chat');
            if (box) {
                box.scrollTop = box.scrollHeight;
            }
        });
    }

    // ---- Speech (TTS) ----
    primeSpeech() {
        if (!window.speechSynthesis) {
            return;
        }
        try {
            window.speechSynthesis.cancel();
            const warm = new SpeechSynthesisUtterance(' ');
            warm.volume = 0;
            window.speechSynthesis.speak(warm);
        } catch (e) {
            /* ignore */
        }
    }

    speak(text) {
        if (!window.speechSynthesis || !text) {
            return;
        }
        const synth = window.speechSynthesis;
        synth.cancel();
        if (synth.paused) {
            synth.resume();
        }
        // Ignore mic input while the agent talks (so it doesn't transcribe its own
        // voice) but WITHOUT stopping recognition — stopping/restarting is unreliable
        // on mobile and was what got the mic stuck. A watchdog clears the flag, but
        // ONLY after audio truly started (see _ttsStarted) so it can't clear in the
        // gap before playback begins — that early clear was letting the agent's voice
        // leak in as a fake "user turn" (which then blocked your real reply).
        this._ttsActive = true;
        this._ttsStarted = false;
        this.speaking = true;
        this._ttsStartDeadline = Date.now() + 1500; // if audio never starts, give up gating
        const u = new SpeechSynthesisUtterance(text);
        u.rate = 1.0;
        u.lang = 'en-US';
        u.volume = 1.0;
        u.onstart = () => {
            this._ttsStarted = true; // confirmed: audio is now playing
        };
        u.onend = () => {
            this.endTts();
        };
        u.onerror = () => {
            this.endTts();
        };
        synth.speak(u);
        this.startTtsWatchdog();
        // Hard cap: if the speech engine hangs (a known mobile/Chrome bug where
        // `speaking` never goes false), force-clear so the mic can never freeze.
        if (this._ttsCap) {
            clearTimeout(this._ttsCap);
        }
        const capMs = Math.min(30000, 3000 + text.length * 90);
        // eslint-disable-next-line @lwc/lwc/no-async-operation
        this._ttsCap = setTimeout(() => {
            try {
                synth.cancel();
            } catch (e) {
                /* ignore */
            }
            this.endTts();
        }, capMs);
    }

    /** Central "speech finished" handler: clear the speaking flag. */
    endTts() {
        this._ttsActive = false;
        this._ttsStarted = false;
        this.speaking = false;
        if (this._ttsCap) {
            clearTimeout(this._ttsCap);
            this._ttsCap = null;
        }
    }

    /**
     * BARGE-IN: hard-stop whatever the agent is currently saying so we can listen
     * to the user immediately. Called when the mic hears genuine (non-echo) user
     * speech while the agent is talking.
     */
    stopSpeaking() {
        if (window.speechSynthesis) {
            try {
                window.speechSynthesis.cancel();
            } catch (e) {
                /* ignore */
            }
        }
        if (this._ttsWatch) {
            clearInterval(this._ttsWatch);
            this._ttsWatch = null;
        }
        this.endTts();
    }

    startTtsWatchdog() {
        if (this._ttsWatch) {
            clearInterval(this._ttsWatch);
        }
        const synth = window.speechSynthesis;
        // eslint-disable-next-line @lwc/lwc/no-async-operation
        this._ttsWatch = setInterval(() => {
            if (!synth) {
                this.endTts();
                clearInterval(this._ttsWatch);
                this._ttsWatch = null;
                return;
            }
            // Confirm audio started (belt-and-braces with u.onstart, which can be
            // flaky on mobile). Only once we've SEEN it speaking do we trust a later
            // "not speaking" to mean it actually finished.
            if (synth.speaking) {
                this._ttsStarted = true;
            }
            if (synth.paused) {
                // Work around the mobile bug where long speech silently pauses.
                try {
                    synth.resume();
                } catch (e) {
                    /* ignore */
                }
            }
            const settled = !synth.speaking && !synth.pending;
            // Don't clear the gate in the pre-playback gap: wait until audio has
            // started, OR the grace window elapsed without it ever starting (engine
            // failed to speak) so the mic can't stay stuck forever.
            const graceElapsed = Date.now() > this._ttsStartDeadline;
            if (settled && (this._ttsStarted || graceElapsed)) {
                this.endTts();
                clearInterval(this._ttsWatch);
                this._ttsWatch = null;
            }
        }, 250);
    }

    // ---- Push-to-talk (hold the mic button to speak, release to send) ----
    // PTT sidesteps the echo problem entirely: the mic is only ever open while the
    // button is held, so it can NEVER hear (and re-transcribe) the agent's own TTS,
    // and there's nothing to "repeat" — you talk, you release, it sends. The press
    // is also a user gesture (which iOS Safari requires to start recognition) and it
    // barges in (stops the agent talking) so you can interrupt at any time.
    /**
     * Lazily create ONE SpeechRecognition instance and reuse it for every press.
     * Re-creating it on each press is what re-triggered the mic-permission prompt
     * over and over on mobile — a single long-lived instance only prompts once.
     */
    ensureRecognizer() {
        if (this._recognizer) {
            return this._recognizer;
        }
        const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SR) {
            return null;
        }
        const rec = new SR();
        rec.continuous = true;
        rec.interimResults = true; // accumulate as they speak, so nothing is lost
        rec.lang = 'en-US';
        rec.onresult = (e) => {
            let full = '';
            for (let i = 0; i < e.results.length; i++) {
                full += e.results[i][0].transcript;
            }
            this._pttTranscript = full.trim();
        };
        rec.onerror = (evt) => {
            // eslint-disable-next-line no-console
            console.warn('[VideoTroubleshoot] PTT STT error:', evt && evt.error);
        };
        rec.onend = () => {
            // stop() flushes a FINAL result just before firing onend — so we send
            // here (not synchronously on release), which is why the tail of your
            // sentence is no longer dropped.
            if (this._pttState === 'stopping') {
                this._pttState = 'idle';
                this.dispatchPtt();
            } else if (this._pttState === 'recording') {
                // iOS/Safari auto-stops after a pause even with continuous=true; while
                // the button is still held we just restart to keep listening.
                try {
                    rec.start();
                } catch (e) {
                    /* ignore */
                }
            }
        };
        this._recognizer = rec;
        return rec;
    }

    startPtt(event) {
        if (event) {
            event.preventDefault();
            // Keep receiving the release even if the finger slides off the button.
            const t = event.currentTarget;
            if (t && t.setPointerCapture && event.pointerId != null) {
                try {
                    t.setPointerCapture(event.pointerId);
                } catch (e) {
                    /* ignore */
                }
            }
        }
        if (this._pttState !== 'idle') {
            return;
        }
        const rec = this.ensureRecognizer();
        if (!rec) {
            this.status = 'Voice input not supported in this browser — type your message instead.';
            return;
        }
        this.stopSpeaking(); // barge-in: cut off any agent/specialist speech
        this._pttTranscript = '';
        this.recording = true;
        this._pttState = 'recording';
        try {
            rec.start();
        } catch (e) {
            // start() throws if the previous session hasn't fully ended; retry shortly.
            // eslint-disable-next-line @lwc/lwc/no-async-operation
            setTimeout(() => {
                if (this._pttState === 'recording') {
                    try {
                        rec.start();
                    } catch (err) {
                        /* ignore */
                    }
                }
            }, 120);
        }
    }

    stopPtt(event) {
        if (event) {
            event.preventDefault();
        }
        if (this._pttState !== 'recording') {
            return;
        }
        this.recording = false;
        this._pttState = 'stopping';
        // Don't read the transcript now — let stop() deliver the final result, then
        // onend calls dispatchPtt() with the COMPLETE phrase.
        try {
            this._recognizer.stop();
        } catch (e) {
            this._pttState = 'idle';
            this.dispatchPtt();
        }
    }

    /** Send whatever was captured during the last hold to the right recipient. */
    dispatchPtt() {
        const said = (this._pttTranscript || '').trim();
        this._pttTranscript = '';
        // eslint-disable-next-line no-console
        console.log('%c[VideoTroubleshoot] 🎤 PTT →', 'color:#0af;font-weight:bold', said || '(nothing heard)');
        if (!said) {
            return;
        }
        if (this.isSpecialist) {
            this.sendSpecialistText(said);
        } else {
            this.handleUserTurn(said);
        }
    }

    /** Suppress the long-press context menu / text-callout on the mic button. */
    handleBlockContext(event) {
        event.preventDefault();
    }

    /** Stop any in-progress recognition (used on teardown / screen changes). */
    stopListening() {
        this.recording = false;
        this._pttState = 'idle';
        this._pttTranscript = '';
        if (this._recognizer) {
            try {
                this._recognizer.abort(); // immediate stop, no final dispatch
            } catch (e) {
                /* ignore */
            }
        }
    }

    // ==================== Specialist (MIAW human handoff) ====================
    /** Stop the agent video session and switch to a live-specialist chat over MIAW. */
    enterSpecialist() {
        if (this.screen === 'specialist') {
            return;
        }
        this.stopListening(); // end the agent voice loop; camera stream stays alive for captures
        if (window.speechSynthesis) {
            window.speechSynthesis.cancel();
        }
        this._ttsActive = false;
        this.clearMarker();
        this._specInit = false;
        this.specMessages = [];
        this.specStatus = this.caseNumber
            ? 'Case ' + this.caseNumber + ' logged — connecting you to a live specialist…'
            : 'Connecting you to a live specialist…';
        this.addSpecMessage('status', this.specStatus);
        this.screen = 'specialist'; // renderedCallback re-attaches the stream + starts the mic
        this.connectSpecialist();
    }

    async connectSpecialist() {
        try {
            const tok = await getUnauthToken();
            this._miawToken = tok.accessToken;
            this._miawConvId = uuid();
            await createConversation(this._miawToken, this._miawConvId);
            this._miawAlive = true;
            // eslint-disable-next-line no-console
            console.log('%c[VideoTroubleshoot] 💬 MIAW conversation created', 'color:#0af', this._miawConvId);

            // Read the SSE stream in the background until we leave specialist mode.
            const resp = await openEventStream(this._miawToken, tok.lastEventId);
            readSse(resp, (e) => this.onMiawEvent(e), () => this._miawAlive).catch((err) => {
                // eslint-disable-next-line no-console
                console.warn('[VideoTroubleshoot] MIAW stream ended:', err);
            });

            // Seed the conversation with context so the specialist knows the situation.
            const intro =
                'Customer escalated from a live video troubleshooting session.' +
                (this.productName ? ' Product: ' + this.productName + '.' : '') +
                (this.caseNumber ? ' Case: ' + this.caseNumber + '.' : '') +
                (this.lastIssue ? ' They said: "' + this.lastIssue + '".' : '');
            await miawSendText(this._miawToken, this._miawConvId, intro, uuid());
            this.specStatus = 'Connected — a specialist will be with you shortly. Type or talk below.';
        } catch (e) {
            // eslint-disable-next-line no-console
            console.error('[VideoTroubleshoot] MIAW connect failed:', this.errMsg(e), e);
            this.specStatus = 'Could not reach a live specialist right now: ' + this.errMsg(e);
            this.addSpecMessage('status', this.specStatus);
        }
    }

    onMiawEvent({ event, data }) {
        const p = parseMiawEvent(event, data);
        if (p.kind === 'specialistMessage') {
            this.specTyping = false;
            this.addSpecMessage('agent', p.text);
            // Read the specialist's reply aloud. Safe now that the mic is
            // push-to-talk (it's closed unless the user is holding the button), so
            // the TTS can't be transcribed back as a fake user turn.
            this.speak(p.text);
        } else if (p.kind === 'status') {
            this.specStatus = p.text;
            this.addSpecMessage('status', p.text);
        } else if (p.kind === 'typing') {
            this.specTyping = p.on;
        }
    }

    sendSpecialistText(text) {
        const t = (text || '').trim();
        if (!t || !this._miawConvId) {
            return;
        }
        this.addSpecMessage('user', t);
        miawSendText(this._miawToken, this._miawConvId, t, uuid()).catch((e) => {
            this.addSpecMessage('status', 'Message failed to send: ' + this.errMsg(e));
        });
    }

    handleTextChange(event) {
        this.textDraft = event.target.value;
    }
    handleTextKeyup(event) {
        if (event.key === 'Enter') {
            this.handleSend();
        }
    }
    handleSend() {
        const t = (this.textDraft || '').trim();
        if (!t) {
            return;
        }
        this.textDraft = '';
        this.sendSpecialistText(t);
    }

    /** Tap 📷 → open the live-camera preview so the user can SEE what they'll share. */
    openCapture() {
        if (!this._miawConvId) {
            this.addSpecMessage('status', 'Not connected — cannot share a photo yet.');
            return;
        }
        this._captureB64 = '';
        this.capture = { open: true, still: '' }; // renderedCallback attaches the live stream
    }

    /** Freeze the current frame so the user can confirm exactly what will be sent. */
    snapCapture() {
        const b64 = this.captureBase64();
        if (!b64) {
            this.addSpecMessage('status', 'Camera not ready — try again in a moment.');
            return;
        }
        this._captureB64 = b64;
        this.capture = { open: true, still: 'data:image/jpeg;base64,' + b64 };
    }

    /** Discard the frozen shot and go back to aiming with the live camera. */
    retakeCapture() {
        this._captureB64 = '';
        this.capture = { open: true, still: '' };
    }

    /** Close the preview without sending anything. */
    cancelCapture() {
        this._captureB64 = '';
        this.capture = { open: false, still: '' };
    }

    /** Send the confirmed still to the specialist (best-effort), then close. */
    async confirmCapture() {
        const b64 = this._captureB64;
        this.capture = { open: false, still: '' };
        this._captureB64 = '';
        if (!b64 || !this._miawConvId) {
            this.addSpecMessage('status', 'Camera not ready to capture a photo.');
            return;
        }
        this.addSpecMessage('user', '📷 Photo shared with the specialist');
        try {
            const blob = this.b64ToBlob(b64, 'image/jpeg');
            await miawSendImage(this._miawToken, this._miawConvId, blob, 'capture.jpg');
        } catch (e) {
            // eslint-disable-next-line no-console
            console.warn('[VideoTroubleshoot] image attach failed, falling back to text:', e);
            await miawSendText(
                this._miawToken,
                this._miawConvId,
                '[Customer shared a photo from their camera, but it could not be attached.]',
                uuid()
            ).catch(() => {});
        }
    }

    b64ToBlob(b64, type) {
        const bytes = atob(b64);
        const arr = new Uint8Array(bytes.length);
        for (let i = 0; i < bytes.length; i++) {
            arr[i] = bytes.charCodeAt(i);
        }
        return new Blob([arr], { type: type || 'image/jpeg' });
    }

    addSpecMessage(role, text) {
        if (!text) {
            return;
        }
        const cls =
            role === 'user'
                ? 'vt-msg vt-msg-user'
                : role === 'status'
                  ? 'vt-spec-status-msg'
                  : 'vt-msg vt-msg-agent';
        this.specMessages = [...this.specMessages, { id: this._mid++, role, text, cls }].slice(-40);
        // eslint-disable-next-line @lwc/lwc/no-async-operation
        Promise.resolve().then(() => {
            const box = this.template.querySelector('.vt-spec-chat');
            if (box) {
                box.scrollTop = box.scrollHeight;
            }
        });
    }

    handleBack() {
        this.teardown();
        this.screen = 'picker';
        this.status = '';
        this.messages = [];
        this.specMessages = [];
        this.sessionId = null;
        this.caseNumber = '';
        this.lastIssue = '';
        this._escalating = false;
        this.capture = { open: false, still: '' };
        this._captureB64 = '';
        this.clearMarker();
    }

    teardown() {
        this.stopConnectAnimation();
        this.stopListening();
        // End the MIAW stream/read loop.
        this._miawAlive = false;
        this._miawToken = null;
        this._miawConvId = null;
        this._specInit = false;
        if (this._ttsWatch) {
            clearInterval(this._ttsWatch);
            this._ttsWatch = null;
        }
        if (this._ttsCap) {
            clearTimeout(this._ttsCap);
            this._ttsCap = null;
        }
        this._ttsActive = false;
        this._ttsStarted = false;
        this.speaking = false;
        this._pttTranscript = '';
        this._recognizer = null;
        if (this.stream) {
            this.stream.getTracks().forEach((t) => t.stop());
            this.stream = null;
        }
        this.videoEl = null;
        this.canvasEl = null;
        this.liveInit = false;
        if (window.speechSynthesis) {
            window.speechSynthesis.cancel();
        }
    }

    // ---- getters / utils ----
    get isPicker() {
        return this.screen === 'picker';
    }
    get isConnecting() {
        return this.screen === 'connecting';
    }
    get isLive() {
        return this.screen === 'live';
    }
    get isSpecialist() {
        return this.screen === 'specialist';
    }
    get captureHasStill() {
        return this.capture.open && !!this.capture.still;
    }
    get captureAiming() {
        return this.capture.open && !this.capture.still;
    }
    get pttClass() {
        return this.recording ? 'vt-mic recording' : 'vt-mic';
    }
    get agentStateLabel() {
        if (this.recording) {
            return 'Listening…';
        }
        if (this.thinking) {
            return 'Thinking…';
        }
        if (this.speaking) {
            return 'Speaking…';
        }
        return 'Hold the mic to talk';
    }
    get agentStateClass() {
        let mod = 'vt-idle';
        if (this.recording) {
            mod = 'vt-st-listening';
        } else if (this.thinking) {
            mod = 'vt-st-thinking';
        } else if (this.speaking) {
            mod = 'vt-st-speaking';
        }
        return 'vt-agentstate ' + mod;
    }
    get canStart() {
        return !!this.selectedId;
    }
    get startDisabled() {
        return !this.selectedId;
    }
    get videoClass() {
        return this.mirror ? 'vt-video vt-mirror' : 'vt-video';
    }
    get snapshotClass() {
        return this.mirror ? 'vt-snapshot vt-mirror' : 'vt-snapshot';
    }
    get markerStyle() {
        return (
            'left:' +
            this.marker.leftPct +
            '%; top:' +
            this.marker.topPct +
            '%; width:' +
            this.marker.wPct +
            '%; height:' +
            this.marker.hPct +
            '%;'
        );
    }
    decorateProducts() {
        this.products = this.products.map((p) => ({
            ...p,
            cls: p.id === this.selectedId ? 'vt-card selected' : 'vt-card'
        }));
    }
    errMsg(e) {
        return e && e.body && e.body.message ? e.body.message : e && e.message ? e.message : String(e);
    }

    /**
     * Drop the agent's "I can't mark/highlight it on your screen" disclaimer — the
     * app DOES mark it (Gemini box overlay), so that caveat is wrong and confusing.
     * Removes only the offending clause; if it's phrased "…can't mark it, but it's
     * top-right", the useful "…it's top-right" tail is kept. Everything else is
     * left exactly as-is.
     */
    sanitizeReply(text) {
        if (!text) {
            return text;
        }
        // Unambiguous visual-marking phrasings only, so we don't clip things like
        // "at this point" or "let me show you the steps".
        const CANNOT_MARK =
            /\b(can(?:'|no)?t|can\s?not|cannot|unable to|not able to|don'?t have the ability to|am not able to|no way (?:for me )?to)\b[^.!?]*?\b(mark|highlight|circle|annotate|pinpoint|physically (?:point|show|indicate|highlight)|(?:point|show|indicate)[^.!?]*?\bon (?:the|your) (?:screen|display|image|video|view|feed))\b[^.!?]*/i;
        const parts = text.match(/[^.!?]+[.!?]*/g) || [text];
        const kept = [];
        parts.forEach((sentence) => {
            if (!CANNOT_MARK.test(sentence)) {
                kept.push(sentence.trim());
                return;
            }
            // Salvage a useful contrast clause ("…, but it's on the top-right.").
            const m = sentence.match(/\b(?:but|however|though|instead)\b[,\s]*(.*)$/i);
            if (m && m[1] && m[1].trim().length > 1) {
                let tail = m[1].trim();
                tail = tail.charAt(0).toUpperCase() + tail.slice(1);
                kept.push(tail);
            }
            // otherwise drop the whole disclaimer sentence
        });
        const out = kept
            .join(' ')
            .replace(/\s+/g, ' ')
            .replace(/\s+([.,!?;:])/g, '$1')
            .trim();
        return out || text; // never blank out the whole reply
    }
    /** Reject if a promise (Apex callout) hangs, so the UI never freezes forever. */
    withTimeout(promise, ms, label) {
        let t;
        const timeout = new Promise((_, reject) => {
            // eslint-disable-next-line @lwc/lwc/no-async-operation
            t = setTimeout(() => reject(new Error((label || 'Request') + ' took too long. Please try again.')), ms);
        });
        return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
    }
}
